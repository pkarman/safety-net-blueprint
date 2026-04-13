# Workflow Domain: Design Reference

Industry research and design decisions for the workflow domain, covering task lifecycle, SLA and deadline management, routing, events, and metrics. Informed by how major workflow and case management platforms handle benefits casework, and by the federal regulations that govern processing timelines and quality control.

See [Workflow Domain](workflow.md) for the architecture overview and [Contract-Driven Architecture](../contract-driven-architecture.md) for the contract approach.

**Systems compared:** Atlassian Jira Service Management (JSM), ServiceNow, IBM Cúram, Salesforce Government Cloud, Pegasystems (Pega), Appian, Camunda, WS-HumanTask

**Regulatory standards referenced:** 7 CFR Part 273 (SNAP), 42 CFR Part 435 (Medicaid/MAGI)

---

## Overview

The workflow domain manages caseworker tasks — the units of work assigned to staff during benefits processing. It owns task creation, assignment, state transitions, SLA tracking, and the domain events that drive cross-domain coordination. It does not determine eligibility, manage case data, or send notices — those are other domain concerns.

**Entities owned by this domain:**

- **Task** — a unit of work assigned to a caseworker or queue
- **Queue** — a named pool of tasks routed by program type, geography, or workload
- **SLA** — deadline and clock-pause rules attached to a task based on program type

**What this domain produces:** state transitions, domain events, and SLA tracking that allow supervisors to monitor workload and regulatory compliance, and that trigger downstream actions (notice generation, case creation) via event subscription.

All major platforms have equivalent concepts — task/work item, queue/team, SLA/deadline. The blueprint follows the same model while making the state machine and routing rules independently configurable per state.

---

## What happens during workflow

The workflow lifecycle spans from task creation through completion. The key activities and their sequence:

1. **Task creation** — when a triggering event occurs (e.g., an application is submitted), a caseworker task is created and assigned to the appropriate queue; the regulatory processing clock starts
2. **Queue assignment and routing** — the task is routed to the appropriate queue based on program type, geography, workload, and agency-configured rules; routing logic is fully replaceable per state
3. **Caseworker claim** — a caseworker claims the task from the queue and begins active work
4. **Active processing** — the caseworker reviews submitted data, conducts the required interview, requests and reviews documents, and updates application data
5. **Blocking for external input** — if the caseworker is waiting for the client to respond or a third-party to verify information, the task enters a waiting state; client-caused delays are excluded from the agency's processing clock under federal regulations
6. **Expedited screening** — for SNAP, the caseworker must determine within 1 business day whether the household qualifies for the 7-day expedited track; if so, the task is escalated to a higher-priority SLA track
7. **Escalation** — when a deadline approaches or supervisor involvement is needed, the task is escalated; escalation does not pause the agency's regulatory clock — the deadline continues running
8. **Supervisor review** — for determinations requiring quality control sign-off (SNAP, Medicaid), the caseworker submits for supervisor review; the supervisor either approves or returns the task for revision
9. **Completion** — the task is marked complete; downstream domains are notified via events

**What workflow does not cover:** eligibility rules, approval/denial decisions, notice generation, case data management. Those are downstream domain concerns that subscribe to workflow events.

---

## Regulatory requirements

### Processing deadlines

Federal law sets maximum processing timelines that begin at application receipt, not when a caseworker claims the task.

**SNAP (7 CFR § 273.2):** 30-day processing deadline from application receipt. Expedited households must be processed within 7 days. Client-caused delays (waiting for the client to respond) are excluded from the agency's deadline calculation — the clock pauses, not stops.

**Medicaid (42 CFR § 435.912):** 45-day processing deadline (90 days for disability-based Medicaid) from application receipt.

### Quality control requirements

**SNAP (7 CFR § 275):** Federal quality control audits review a sample of cases each year. Determinations must be documented and, in many states, supervisor-reviewed before finalization. The workflow domain supports structured supervisor sign-off as a first-class lifecycle state.

**Medicaid (42 CFR Part 431, Subpart F):** Similar QC framework; states must maintain documentation of eligibility determinations.

---

## Task lifecycle

### States

| State | SLA clock | Description |
|---|---|---|
| `pending` | running | Task created; in queue awaiting claim |
| `in_progress` | running | Claimed by a caseworker; actively being worked |
| `awaiting_client` | paused | Waiting for the client to respond or provide information; federal regulations exclude this time from the agency's deadline |
| `awaiting_verification` | paused | Waiting for a third-party verification service to return results |
| `escalated` | running | Elevated for supervisor attention; agency deadline continues running |
| `pending_review` | running | Submitted for supervisor sign-off; supervisor must approve or return for revision |
| `completed` | stopped | Work finished; regulatory deadline no longer applies |
| `cancelled` | stopped | Task abandoned; can be reopened by a supervisor, which resets routing via `pending` |

All states have an explicit `slaClock` value — see [Decision 12](#decision-12-slaclock-required-on-every-state). The `awaiting_*` states use `paused` rather than `stopped` — see [Decision 13](#decision-13-awaiting-states-pause-the-sla-clock).

Task-type-specific states (e.g., `hearing_scheduled` for fair hearing tasks) are added alongside these baseline states and are only reachable via transitions guarded on task type — see [Decision 9](#decision-9-guards-on-tasktype-enable-multiple-lifecycles-per-state-machine).

### Key transitions

- **`claim`**: `pending` → `in_progress` — caseworker takes ownership from the queue; see [Decision 4](#decision-4-named-rpc-transitions-not-patch)
- **`await-client`**: `in_progress` → `awaiting_client` — caseworker is waiting on the client; pauses SLA clock
- **`await-verification`**: `in_progress` → `awaiting_verification` — caseworker waiting on a third-party data source; pauses SLA clock
- **`resume`**: `awaiting_*` → `in_progress` — caseworker resumes after external input received; clock resumes
- **`system-resume`**: `awaiting_verification` → `in_progress` — automated callback from a verification service; see [Decision 8](#decision-8-automated-verification-uses-a-dedicated-system-resume-trigger)
- **`escalate`**: `pending` | `in_progress` → `escalated` — caseworker or timer escalates for supervisor attention; re-evaluates priority via rules engine
- **`de-escalate`**: `escalated` → `pending` — supervisor resolves; returns to queue for re-claim (handles both assigned and unassigned origin states cleanly)
- **`submit-for-review`**: `in_progress` → `pending_review` — caseworker requests supervisor sign-off
- **`approve`**: `pending_review` → `completed` — supervisor approves; task closes
- **`return-to-worker`**: `pending_review` → `in_progress` — supervisor returns for revision; keeps task with the same caseworker rather than re-queuing
- **`complete`**: `in_progress` → `completed` — caseworker marks work done (no review required)
- **`cancel`**: `pending` | `in_progress` | `escalated` → `cancelled` — supervisor-only; see [Decision 7](#decision-7-cancel-is-supervisor-only-no-notify-effect)
- **`reopen`**: `cancelled` → `pending` — supervisor reinstates; clears assignment for fresh routing

Timer-triggered transitions fire automatically when durations elapse. See [Decision 6](#decision-6-calendartype-is-explicit-per-timer-transition) for how calendar vs. business-hour deadlines are handled.

### Lifecycle hooks

**`onCreate`** — fires when a task is created. Used to invoke routing rules, set initial priority, and emit a creation event.

**`onUpdate`** — fires when specific fields change via an external update (not a transition). The `fields` filter explicitly declares which field changes have downstream effects — e.g., `isExpedited` and `programType`, but not `assignedToId` (set by transitions). Transition-internal field changes do not trigger `onUpdate`.

---

## SLA and deadline management

Each task carries one `slaInfo` record per applicable SLA type. Multiple SLA types can apply simultaneously — a SNAP application initially filed as standard may later be determined to qualify for expedited processing, at which point both deadlines apply. See [Decision 15](#decision-15-multiple-sla-types-can-apply-per-task).

SLA type definitions live in `*-sla-types.yaml`, separately from the state machine, and are independently replaceable per state. The baseline types derived from federal regulatory deadlines:

| SLA type | Duration | Warning threshold | Pauses when |
|---|---|---|---|
| `snap_expedited` | 7 days | 75% elapsed | `awaiting_client` or `awaiting_verification` |
| `snap_standard` | 30 days | 75% elapsed | `awaiting_client` or `awaiting_verification` |
| `medicaid_standard` | 45 days | 75% elapsed | `awaiting_client` or `awaiting_verification` |
| `medicaid_disability` | 90 days | 75% elapsed | `awaiting_client` or `awaiting_verification` |

All baseline durations are derived from federal regulations. See [Decision 14](#decision-14-sla-type-definitions-are-independently-replaceable).

---

## Domain events

Domain events serve two purposes: they are the audit trail required by federal and state regulations, and they are the integration surface for cross-domain communication. Other domains (communication, case management, eligibility) subscribe to workflow events rather than polling task state.

The state machine YAML is the authoritative source for what events exist and what they carry — `event` effects declare the action name and data payload. The audit trail is immutable — events are never modified or deleted via the API. See [Decision 18](#decision-18-events-in-a-shared-collection-across-domains) and [Decision 17](#decision-17-the-audit-trail-is-immutable).

---

## Metrics

Metrics are defined as YAML contract artifacts in `workflow-metrics.yaml`, alongside the state machine — not in a proprietary GUI. This makes measurement definitions explicit, versionable, and portable across state implementations. See [Decision 18](#decision-18-metrics-as-yaml-contract-artifacts).

---

## Key design decisions

| # | Decision | Summary |
|---|---|---|
| 1 | [Task state is explicit, not derived](#decision-1-task-state-is-explicit-not-derived) | State is a first-class field — not computed from timestamps or conditions. |
| 2 | [`awaiting_client` and `awaiting_verification` as separate states](#decision-2-awaiting_client-and-awaiting_verification-as-separate-first-class-states) | Federal regulations treat client-caused and agency-caused delays differently — collapsing them loses that distinction. |
| 3 | [`pending_review` as dedicated supervisor sign-off state](#decision-3-pending_review-as-a-dedicated-supervisor-sign-off-state) | QC regulations require structured supervisor approval before determination — distinct from escalation. |
| 4 | [Named RPC transitions, not PATCH](#decision-4-named-rpc-transitions-not-patch) | Named triggers map cleanly to audit events, can carry request bodies, and can be independently guarded. |
| 5 | [Effects declared in state machine YAML](#decision-5-effects-declared-in-state-machine-yaml) | The contract is the specification — implementations don't need to read source code to understand what a transition does. |
| 6 | [`calendarType` explicit per timer transition](#decision-6-calendartype-is-explicit-per-timer-transition) | Regulatory deadlines are calendar days; staffing SLAs are business hours — conflating them produces incorrect enforcement. |
| 7 | [`cancel` is supervisor-only; no `notify` effect](#decision-7-cancel-is-supervisor-only-no-notify-effect) | Cancellation has federal reporting implications; notification is a consumer concern handled by event subscribers. |
| 8 | [Automated verification uses a dedicated `system-resume` trigger](#decision-8-automated-verification-uses-a-dedicated-system-resume-trigger) | Keeps automated callbacks distinguishable from human actions in the audit trail — required for SNAP/Medicaid QC. |
| 9 | [Guards on `taskType` enable multiple lifecycles per state machine](#decision-9-guards-on-tasktype-enable-multiple-lifecycles-per-state-machine) | One API surface and shared infrastructure serving multiple task types without separate state machines or endpoints. |
| 10 | [`workflow-rules.yaml` is independently replaceable](#decision-10-workflow-rulesyaml-is-independently-replaceable) | Routing logic varies significantly across states — decoupling it from the state machine lets each change independently. |
| 11 | [`first-match-wins` rule evaluation](#decision-11-first-match-wins-rule-evaluation) | Simple and predictable; multi-factor weighted scoring is a known gap. |
| 12 | [`slaClock` required on every state](#decision-12-slaclock-required-on-every-state) | No default prevents silent regressions when new states are added. |
| 13 | [`awaiting_*` states pause the SLA clock](#decision-13-awaiting-states-pause-the-sla-clock) | Federal SNAP regulations treat client-caused delays as excluded time — pausing preserves the original deadline rather than granting a fresh one. |
| 14 | [SLA type definitions are independently replaceable](#decision-14-sla-type-definitions-are-independently-replaceable) | Deadline values vary by program mix — states replace the file without touching lifecycle logic. |
| 15 | [Multiple SLA types can apply per task](#decision-15-multiple-sla-types-can-apply-per-task) | A SNAP task may become expedited after initial creation — both deadlines must apply simultaneously. |
| 16 | [`pauseWhen`/`resumeWhen` per SLA type, not a hardcoded state list](#decision-16-pausewhenresumewhen-per-sla-type) | Different SLA types can pause on different conditions — a state might pause `snap_standard` but not `snap_expedited` during `awaiting_client`. |
| 17 | [The audit trail is immutable](#decision-17-the-audit-trail-is-immutable) | Federal QC reviews and fair hearings depend on an unaltered history — mutations undermine the regulatory function. |
| 18 | [Metrics as YAML contract artifacts](#decision-18-metrics-as-yaml-contract-artifacts) | Metric definitions are explicit, versionable, and portable — unlike proprietary GUI dashboards. |
| 19 | [Duration metrics via event pairs, not pre-computed fields](#decision-19-duration-metrics-via-event-pairs) | Declarative model lets metric authors define new measurements without schema changes. |
| 20 | [Pre-aggregation is an adapter-layer concern](#decision-20-pre-aggregation-is-an-adapter-layer-concern) | On-demand computation is simpler and always current for the baseline; states add pre-aggregation in their adapters. |
| 21 | [Rule context enrichment via explicit entity bindings](#decision-21-rule-context-enrichment-via-explicit-entity-bindings) | Rule conditions reference subject entity fields via declared bindings; the engine resolves only what is declared before evaluation. |

---

### Decision 1: Task state is explicit, not derived

**Status:** Decided

**What's being decided:** Whether task state is stored as an explicit field or computed from timestamps and other conditions.

**Considerations:**
- Deriving state from timestamps is fragile — if `completedAt` is set but then cleared, the state is ambiguous; if a timer fires but the update fails, the state is silently wrong
- All major platforms model task state explicitly: JSM (`status`), ServiceNow (`state`), Pega (`pyStatusWork`), Appian (`status`), WS-HumanTask (explicit state enum)
- Explicit state is unambiguous, directly queryable, and produces clean audit events on each transition

**Decision:** Task state is a first-class, explicitly stored field. State changes only via named transitions.

**Customization:** States can add status values via overlay.

---

### Decision 2: `awaiting_client` and `awaiting_verification` as separate first-class states

**Status:** Decided

**What's being decided:** Whether to model waiting conditions as a single `on_hold` state with sub-reasons, or as separate first-class states.

**Considerations:**
- Federal regulations treat client-caused delays and agency-caused delays differently for SLA accountability and regulatory reporting. Collapsing them into sub-reasons of one state requires parsing sub-reason data to determine SLA behavior — fragile and easy to get wrong.
- How comparable systems handle this:

  | Concept | Blueprint | JSM | ServiceNow | Curam | Salesforce Gov Cloud | WS-HumanTask |
  |---|---|---|---|---|---|---|
  | Waiting for client | `awaiting_client` | Waiting for Customer | On Hold / Awaiting Caller | Manual activity pending | Waiting on Someone Else | Suspended |
  | Waiting for third-party | `awaiting_verification` | Pending | On Hold / Awaiting Evidence | Suspended process | Deferred | Suspended |

- Pega delays SLA clock start via an **Assignment Ready** field rather than pausing a running clock — a different approach with different federal reporting implications (delayed start vs. excluded interval).
- ServiceNow collapses both into `on_hold` sub-reasons; first-class states enable distinct timer behavior and clearer federal reporting without sub-reason parsing.

**Decision:** `awaiting_client` and `awaiting_verification` are separate first-class states with distinct SLA clock behavior and distinct domain events.

**Customization:** States can override `slaClock` per state via overlay (e.g., treating client non-response as stopped rather than paused).

---

### Decision 3: `pending_review` as a dedicated supervisor sign-off state

**Status:** Decided

**What's being decided:** Whether supervisor approval before determination is a first-class lifecycle state or an ad-hoc step outside the state machine.

**Considerations:**
- SNAP and Medicaid QC regulations require supervisor approval before a determination is finalized in many states. Without a first-class state, this approval is invisible to the state machine — no clean SLA accountability, no audit event, no queue visibility.
- This is distinct from escalation: escalation is upward for help or urgency; `pending_review` is a structured approval gate before completion.
- JSM and ServiceNow both support approval states within workflows; Pega models these as approval shapes in the case lifecycle.

**Decision:** `pending_review` is a dedicated state. The caseworker submits via `submit-for-review`; the supervisor either `approve`s (→ `completed`) or `return-to-worker`s (→ `in_progress`). The SLA clock keeps running — supervisor review counts against the agency's deadline.

**Customization:** States where regulation explicitly excludes review time from the deadline can override `slaClock: paused` on `pending_review` via overlay.

---

### Decision 4: Named RPC transitions, not PATCH

**Status:** Decided

**What's being decided:** Whether state changes are triggered by named action endpoints or by PATCH requests on the task resource.

**Considerations:**
- PATCH requires parsing the diff to determine what changed and whether it was authorized — the intent of the change is implicit. Named triggers make intent explicit.
- Named triggers map cleanly to audit events, can carry an action-specific request body (e.g., a cancellation reason), and can be independently guarded.
- How comparable systems handle transitions:

  | | Blueprint | JSM | ServiceNow | Camunda | WS-HumanTask | Pega | Appian |
  |---|---|---|---|---|---|---|---|
  | Trigger | Named trigger → RPC endpoint | Status transition button | State flow trigger | Sequence flow / signal | Claim, start, complete, skip | Named flow action → RPC | Generic BPMN gateway |
  | Precondition | Guards | Validator condition | Condition script | Gateway condition | Potential owner constraints | Decision rule / router | Conditional expression |
  | Side effect | `set`, `create`, `evaluate-rules`, `event` | Post-function | Business Rule | Execution Listener | Task handler | Declare Expressions + activity | Smart Services |
  | Conditional effect | `when` (JSON Logic) | — | Condition on Business Rule | Expression on Listener | — | Condition on activity | Conditional gateway |

**Decision:** Each transition trigger becomes a named RPC endpoint (`POST /tasks/:id/claim`). PATCH is reserved for updating task fields (not state changes).

**Customization:** States can add new named transitions via overlay.

---

### Decision 5: Effects declared in state machine YAML

**Status:** Decided

**What's being decided:** Whether transition side effects are declared in the state machine contract or implemented per-endpoint in code.

**Considerations:**
- Declaring effects in the contract makes the behavior inspectable and independently verifiable — a reviewer can understand what a transition does without reading source code.
- JSM and ServiceNow build audit records as a side effect of internal processing — the schema is implicit and not independently inspectable.
- Effect types: `set` (update fields), `evaluate-rules` (invoke rules engine), `event` (emit domain event), `create` (write a new record), `when` (conditional wrapper using JSON Logic).

**Decision:** Effects are declared in the state machine YAML and executed by the engine. The contract is the specification.

**Customization:** States can add effects to existing transitions via overlay.

---

### Decision 6: `calendarType` is explicit per timer transition

**Status:** Decided

**What's being decided:** Whether timer transitions use calendar days or business hours, and how that is expressed.

**Considerations:**
- Regulatory deadlines (SNAP 30-day, Medicaid 45-day) are calendar days. Staffing SLAs are typically business hours. Conflating the two produces incorrect enforcement and federal reporting errors.
- How comparable systems handle this:

  | Concept | JSM | ServiceNow | Curam |
  |---|---|---|---|
  | Calendar vs. business time | Configurable per SLA | Configurable per schedule | Configurable per deadline |
  | Time-based transition | SLA timer → auto-transition on breach | Escalation rule with time condition | Deadline escalation on process |

- Setting the wrong type silently miscalculates deadlines — making it explicit and required prevents silent errors.

**Decision:** `calendarType` is an explicit, required field per timer transition: `calendar` for regulatory deadlines, `business` for staffing SLAs. All `after` durations in the baseline are illustrative placeholders — states must override them per program type and regulatory requirement.

**Baseline timer transitions:**

| Trigger | From | To | After | Relative to | Calendar type |
|---|---|---|---|---|---|
| `auto-escalate` | `pending` | `escalated` | 72h | `createdAt` | business |
| `auto-escalate-sla-warning` | `in_progress` | `escalated` | -48h | `slaDeadline` | calendar |
| `auto-escalate-sla-breach` | `pending`, `in_progress`, `escalated` | `escalated` | 0h | `slaDeadline` | calendar |
| `auto-cancel-awaiting-client` | `awaiting_client` | `cancelled` | 30d | `blockedAt` | calendar |
| `auto-resume-awaiting-verification` | `awaiting_verification` | `in_progress` | 7d | `blockedAt` | calendar |

**Customization:** All durations are overlay points. `calendarType` can be overridden per transition. Timer transitions support an optional `guards` field for conditional suppression.

---

### Decision 7: `cancel` is supervisor-only; no `notify` effect

**Status:** Decided

**What's being decided:** Two related access control and integration decisions for `cancel`.

**Considerations:**
- Cancelling a benefits task has federal reporting and client appeal implications — caseworkers cannot cancel unilaterally. JSM, ServiceNow, and Curam all restrict cancellation to privileged roles.
- A `notify` effect type would couple the workflow domain to specific notification delivery mechanisms. JSM, ServiceNow, and Curam all have built-in notification on escalation, which creates tight coupling to delivery channels. States that need push notifications should build notification services that subscribe to domain events — the decoupled model.

**Decision:** `cancel` is restricted to supervisors. There is no `notify` effect type — notification is a consumer concern handled by subscribers to domain events.

**Customization:** States that want a worker-initiated cancellation request with supervisor approval can model this via a custom `request-cancel` state.

---

### Decision 8: Automated verification uses a dedicated `system-resume` trigger

**Status:** Decided

**What's being decided:** Whether automated callbacks from verification services (IEVS, FDSH) use the same `resume` trigger as human caseworkers or a dedicated trigger.

**Considerations:**
- SNAP and Medicaid QC requirements distinguish automated callbacks from human caseworker actions in the audit trail. A separate trigger keeps domain events distinguishable and allows the request body to carry verification result data (source, result summary).
- A relaxed guard on the shared `resume` trigger would allow system actors to use it, but the resulting domain event would be indistinguishable from a human resuming the task.

**Decision:** Automated verification callbacks use a dedicated `system-resume` trigger, guarded by `callerIsSystem`. The resulting event is distinct from the human `task.resumed` event.

---

### Decision 9: Guards on `taskType` enable multiple lifecycles per state machine

**Status:** Decided

**What's being decided:** Whether task-type-specific states and transitions require separate state machine files and API resources, or can be expressed within a single state machine.

**Considerations:**
- Requiring a separate state machine and API resource per task type would fragment the API surface and duplicate shared infrastructure (queues, SLA tracking, domain events, assignment rules).
- Pega (`caseTypeID`), Salesforce (`RecordTypeId`), and JSM (issue type) all scope available operations within a single object type's API — the blueprint follows the same pattern.
- Task-type-specific transitions carry a named guard checking `$object.taskType`. Shared transitions (`cancel`, `assign`, `set-priority`) carry no task type guard and apply to all types.
- Trade-off: the OpenAPI status enum includes states from all task types, so `taskType` is the authoritative constraint on which states are reachable — not the schema.

**Decision:** Task-type-specific states and transitions are added to the baseline state machine and guarded on `$object.taskType`. One API surface; shared infrastructure; multiple lifecycles.

**Customization:** States add task-type-specific transitions and guards via overlay, with `taskType` guards scoping them appropriately.

---

### Decision 10: `workflow-rules.yaml` is independently replaceable

**Status:** Decided

**What's being decided:** Whether routing and priority rules are embedded in the state machine or defined in a separate, independently replaceable file.

**Considerations:**
- Routing logic varies significantly across states — program mix, geography, workload balancing, and organizational structure all affect assignment rules. Entangling routing with lifecycle logic would make both harder to change.
- How comparable systems decouple routing:

  | | JSM | ServiceNow | Camunda | Pega | Appian |
  |---|---|---|---|---|---|
  | Routing rules | Automation rules | Assignment rules | Task listener | Push (system assigns) + Pull (Get Next Work) | Automated Case Routing module |
  | Priority rules | Field automation | SLA-based priority | — | Urgency (1–100) | KPI-based |
  | Rule order | First matching automation | Rule processing order | — | Decision tree precedence | Rule number precedence |

- Pega supports both push (system assigns) and pull (worker requests next task) routing. The blueprint uses push routing only; pull routing is a known gap — see [Known gaps](#routing-and-assignment).

**Decision:** `workflow-rules.yaml` is entirely replaceable per state. Rules are invoked via `evaluate-rules` effects in the state machine — neither system needs to understand the other's internals.

**Customization:** States replace `workflow-rules.yaml` entirely. States can add `evaluate-rules` effects to additional transitions via overlay.

---

### Decision 11: `first-match-wins` rule evaluation

**Status:** Decided

**What's being decided:** The evaluation model for routing and priority rules.

**Considerations:**
- `first-match-wins` is simple, predictable, and easy to debug. Rules are evaluated in order; the first match wins.
- Multi-factor weighted scoring — combining urgency, program type, task age, and other attributes into a numeric priority — is not expressible with `first-match-wins`. This is a known gap; see [Known gaps](#routing-and-assignment).
- `escalate` uses `evaluate-rules: priority` rather than `set priority: high` — hardcoding a priority value would break states with different escalation behavior per program type.

**Decision:** `first-match-wins`. Weighted scoring is a planned enhancement — see issue #200.

---

### Decision 12: `slaClock` required on every state

**Status:** Decided

**What's being decided:** Whether `slaClock` has a default value or must be explicitly declared on every state.

**Considerations:**
- If `slaClock` had a default, new states added via overlay could silently inherit the wrong clock behavior — running when they should pause, or stopping when they should run.
- Requiring explicit declaration forces intentional choices and prevents silent regressions. The schema enforces this.

**Decision:** `slaClock` is required on every state with no default. The valid values are `running`, `paused`, and `stopped`.

---

### Decision 13: `awaiting_*` states pause the SLA clock

**Status:** Decided

**What's being decided:** Whether waiting states use `slaClock: paused` or `slaClock: stopped`.

**Considerations:**
- Federal SNAP regulations treat client-caused delays as excluded time — not as time that resets the agency's clock. `paused` means the clock resumes from where it left off, preserving the original deadline. `stopped` would grant a fresh deadline on each block/resume cycle, distorting federal reporting.
- How comparable systems handle SLA pausing:

  | Concept | Blueprint | JSM | ServiceNow | Curam | Pega | Appian |
  |---|---|---|---|---|---|---|
  | Pause SLA | `slaClock: paused` on waiting states | "Pending" status excludes from SLA | On Hold sub-reasons pause SLA | Process-level SLA tracking | Assignment Ready delays clock start | No built-in pause; custom logic |
  | Stop SLA | `slaClock: stopped` on terminal states | Resolved / Closed | Resolved / Closed | Process completed | Case resolution | Process completion |

**Decision:** `awaiting_client` and `awaiting_verification` use `slaClock: paused`. The clock resumes from the same point when the task returns to `in_progress`.

**Customization:** States that treat client non-response as the client's time to spend (stopping rather than pausing) can override `slaClock` via overlay.

---

### Decision 14: SLA type definitions are independently replaceable

**Status:** Decided

**What's being decided:** Whether SLA deadline values are embedded in the state machine or defined in a separate, independently replaceable file.

**Considerations:**
- States with different program mixes need different deadline values. Embedding deadlines in the state machine would couple two concerns that change independently.
- JSM and ServiceNow store SLA definitions as separate database records, decoupled from workflow configuration. The blueprint follows the same separation with `*-sla-types.yaml`.

**Decision:** SLA type definitions live in `*-sla-types.yaml`, separately from the state machine, and are independently replaceable per state.

**Customization:** States replace or extend SLA types via overlay. `autoAssignWhen` logic can be adjusted to match state-specific program routing criteria.

---

### Decision 15: Multiple SLA types can apply per task

**Status:** Decided

**What's being decided:** Whether a task can have multiple active SLA deadlines simultaneously.

**Considerations:**
- A SNAP application initially filed as standard may later be determined to qualify for expedited processing. Both the 30-day standard and 7-day expedited deadlines then apply.
- IBM Curam's single-deadline-per-process model is less flexible for multi-program cases.
- JSM and ServiceNow both support multiple SLA records per work item.

  | Concept | JSM | ServiceNow | IBM Curam | Salesforce Gov Cloud |
  |---|---|---|---|---|
  | Multiple SLAs per record | Yes | Yes | Typically one per process | Multiple milestones per case |
  | Auto-attach conditions | Automation rule conditions | SLA Definition conditions | Configured at design time | Entitlement criteria |

**Decision:** Each task carries one `slaInfo` entry per applicable SLA type. Multiple SLA types can apply simultaneously.

---

### Decision 16: `pauseWhen`/`resumeWhen` per SLA type

**Status:** Decided

**What's being decided:** Whether SLA clock pause/resume behavior is determined by a hardcoded state list or by per-SLA-type JSON Logic conditions.

**Considerations:**
- Different SLA types may need different pause behavior on the same state. A state might pause `snap_standard` but not `snap_expedited` during `awaiting_client` (the 7-day clock keeps running). Hardcoding pause behavior to a list of states cannot express this.
- ServiceNow's on-hold conditions work the same way — conditions are expressed per SLA definition, not as a global state list.
- Warning thresholds are expressed as a percentage of the total SLA duration (75%), not a fixed offset — 75% of 7 days and 75% of 90 days scale appropriately. ServiceNow uses the same percentage model.

**Decision:** `pauseWhen` and `resumeWhen` are JSON Logic conditions defined per SLA type, evaluated on every transition.

**Customization:** `pauseWhen` conditions can be tightened or loosened per regulatory interpretation via overlay.

---

### Decision 17: The audit trail is immutable

**Status:** Decided

**What's being decided:** Whether events can be modified or deleted after they are written.

**Considerations:**
- Federal QC reviews and fair hearings depend on an unaltered history of who acted, when, and why. Allowing mutations would undermine the regulatory function of the record.
- All major platforms maintain read-only audit trails: JSM (issue history), ServiceNow (audit log), Camunda (history service).

  | Concept | JSM | ServiceNow | Camunda | WfMC |
  |---|---|---|---|---|
  | Transition audit | Issue history | Audit log | User Operation Log | Task Event History |
  | Immutable log | Read-only history | Read-only audit | History service | — |

**Decision:** Events are never POST'd, PATCH'd, or DELETE'd via the API.

---

### Decision 18: Metrics as YAML contract artifacts

**Status:** Decided

**What's being decided:** Whether metric definitions are expressed as contract artifacts or configured in a proprietary GUI.

**Considerations:**
- All major systems define metrics through proprietary GUIs — non-portable and not version-controlled.

  | | JSM | ServiceNow | IBM Curam | Salesforce Gov Cloud | Pega | Appian |
  |---|---|---|---|---|---|---|
  | Metric definitions | Custom gadgets + SLA reports | Performance Analytics indicators | MIS caseload reports | Reports + formula fields | Application Quality dashboards | Process HQ KPIs |
  | Stored vs. computed | Pre-aggregated | Pre-aggregated by PA collector | Pre-computed batch | Pre-aggregated | Pre-aggregated views | Pre-computed |
  | Filter conditions | JQL | Condition builder / script | Fixed filter on report type | SOQL | GUI-based | GUI-based |

- Defining metrics as YAML artifacts makes measurement definitions explicit, versionable, and portable across state implementations. A deliberate departure from industry norms.
- Each metric is defined as a `collection` + `aggregate` + JSON Logic `filter`. Adding a new metric is a data-definition problem, not a code problem.

**Decision:** Metrics are YAML contract artifacts in `workflow-metrics.yaml`, alongside the state machine.

**Customization:** States replace or extend `workflow-metrics.yaml` via overlay. `targets` can be overridden to reflect state-specific performance goals.

---

### Decision 19: Duration metrics via event pairs

**Status:** Decided

**What's being decided:** Whether duration metrics (e.g., time-to-claim) are pre-computed task fields or defined declaratively as event pair correlations.

**Considerations:**
- Pre-computing duration as a task field requires deciding in advance which event pairs define "duration," locking in that decision at schema design time. Adding a new duration measurement requires a schema change.
- The declarative model — `from` event, `to` event, correlated by a `pairBy` field — lets metric authors define new measurements without schema changes. Any pair of events correlated by a shared field qualifies.

**Decision:** Duration metrics are defined via `from`/`to` event pairs correlated by a `pairBy` field.

---

### Decision 20: Pre-aggregation is an adapter-layer concern

**Status:** Decided

**What's being decided:** Whether metrics are pre-aggregated on a schedule or computed on demand.

**Considerations:**
- ServiceNow and JSM pre-aggregate metrics on a schedule for performance. For the blueprint's use case (development mock, contract definition), on-demand computation is simpler and always current.
- States building production implementations will add pre-aggregation in their adapters — the metric definitions remain the same; only the computation strategy changes.

**Decision:** On-demand computation from live data for the baseline. Pre-aggregation is an adapter-layer performance optimization, not a contract concern.

---

### Decision 21: Rule context enrichment via explicit entity bindings

**Status:** Decided

**What's being decided:** How rule conditions access attributes of the subject entity (application, case) when routing or prioritizing a task, without requiring those attributes to be denormalized onto the task.

**Considerations:**
- Routing and priority rules often need subject attributes — program type, county, household size — that live on the application or case record, not the task. Requiring states to copy these fields onto the task at creation couples the task schema to the subject schema and fails when those attributes change after creation.
- **Pega** resolves this via the clipboard: all case data is in-memory and in-scope during routing rule evaluation without any explicit step. Full live traversal is available, but the data dependencies of a rule are implicit — invisible unless you read the rule's condition logic.
- **ServiceNow** uses dot-walking (SQL JOINs) for live traversal in conditions, but this has documented limitations in the no-code condition builder; scripted fallbacks are required for change-triggered rules.
- **Salesforce** surfaces related record fields via cross-object formula fields — effectively live computed values — but requires an explicit `Get Records` action in Flow before conditions can reference non-formula fields.
- **JSM** pre-loads parent/epic data into the automation context at trigger time; linked issue data requires an explicit Lookup Issues action before it can be referenced in conditions.
- **Appian CMS** takes the most constrained approach: developers configure which related record fields are available to rule authors; the platform fetches those values at evaluation time. Rule data dependencies are explicit and bounded by configuration.
- **IBM Cúram** passes pre-defined Workflow Data Objects (WDOs) to CER allocation rules — a structured, bounded context that the engine assembles. Arbitrary related-record access requires a custom function strategy.
- The blueprint's rules are defined in YAML contract artifacts — the data dependencies of a rule set should be as readable as the rules themselves. Implicit live traversal (Pega/ServiceNow) makes those dependencies invisible without running the rules.

**Options:**
- **(A)** Denormalization — copy subject fields onto the task at creation. Simple to evaluate; couples task schema to subject schema; fails when subject data changes post-creation.
- **(B)** Arbitrary live traversal — the engine resolves any related entity on demand during condition evaluation. Maximum flexibility; data dependencies are implicit and invisible in the contract artifact.
- **(C) ✓** Explicit context bindings — rule authors declare which entities to resolve in the rules YAML (`as`, `entity`, `from`). The engine fetches only what is declared before evaluation. Data dependencies are visible in the artifact itself, not buried in condition logic.

**Decision:** Explicit context bindings (C). This follows the bounded-context model of Appian and Cúram — the most portable pattern for a blueprint that states customize. Unlike denormalization, it does not couple the task schema to the subject schema. Unlike arbitrary traversal, it keeps data dependencies readable in the contract artifact. States can extend context bindings via overlay to expose additional subject fields to rules without modifying the engine.

**Implementation details:**

**Per-ruleSet context scope:** Context bindings are declared per-ruleSet (not globally), so each ruleSet resolves only what it needs. This matches JSM (lookup issue actions are per-automation rule), Appian CMS (related record configuration is per-allocation rule), IBM Cúram (WDOs are defined per allocation table), and Salesforce Flow (`Get Records` is placed per-flow). Pega's global clipboard — all case data always in scope — is the outlier; it maximizes flexibility at the cost of invisible data dependencies.

**`this` alias for the calling resource:** The record being evaluated is always available as `this` in rule conditions without a binding declaration. This follows the universal pattern: Pega's primary page (the current case, always in scope), ServiceNow's `current` (built-in JavaScript reference), JSM's `{{issue.*}}` Smart Values (triggering issue is the base context), and Salesforce's `{!$Record.*}`. No vendor requires an explicit declaration to access the primary record.

**Entity reference format (`domain/resource`):** Entities are identified in `domain/resource` format (e.g., `intake/applications`), matching CloudEvents source semantics used elsewhere in the blueprint. The collection name is the last path segment. There is no direct vendor equivalent — Pega references page classes, ServiceNow references GlideRecord tables — but the two-segment format is unique to our multi-domain contract architecture and provides namespacing without a full URI.

**Chaining:** Bindings are resolved in declaration order; each binding's `from` path can reference previously resolved entities, enabling multi-hop traversal (e.g., `from: application.caseId` to resolve a case via an application). Pega and ServiceNow support arbitrary-depth dot-walking natively. JSM supports only single-level lookup. Appian CMS allows one level of related record access per rule set. IBM Cúram WDOs are flat — chaining requires defining additional WDO members. The blueprint's approach is more flexible than JSM/Appian/Cúram but bounded (declared in the contract) unlike Pega/ServiceNow's implicit traversal.

**Sub-resource constraint:** Entity references must be exactly two segments (`domain/resource`). Sub-resources (e.g., `/cases/{caseId}/documents`) are not supported because entity lookup is by globally unique ID, which sub-resources lack without parent context. All major vendors (ServiceNow GlideRecord, Salesforce objects, Pega page classes) reference entities by flat type, not by hierarchical path — this constraint is consistent with industry practice.

**Static validation:** `validate-rules.js` runs at `npm run validate` and checks entity paths against discoverable API resources and `from` fields against the calling resource's schema. Runtime behavior: entity not found skips the rule set (error logged); missing `from` field value skips the binding (warning logged).

**Known gap:** Runtime error handling — what surfaces to callers when rule evaluation is skipped, how to distinguish degraded evaluation from no-op evaluation — is a separate design concern. See [issue #220](https://github.com/codeforamerica/safety-net-blueprint/issues/220).

**Customization:** States add or replace context bindings in their overlay of `workflow-rules.yaml` to expose additional subject entity fields to rule conditions.

---

## Known gaps and future considerations

Standard capabilities found in major workflow systems (JSM, ServiceNow, IBM Cúram, Salesforce Government Cloud, Pega, Appian), and the blueprint's current coverage. See [References](#references) for system descriptions.

Status values: **Planned** = on the roadmap with a tracking issue; **Partial** = some coverage exists; **Not in scope** = intentional design boundary (handled by another domain); **Adapter layer** = intentionally delegated to the state adapter; **Gap** = not yet assessed.

### Workflow engine

| Capability | Industry standard | Blueprint status |
|---|---|---|
| State machine versioning | All major platforms handle in-flight task migration when workflow definitions change — Pega via case type versioning, ServiceNow via flow version management | **Adapter layer** — migration strategy depends on the adapter's persistence model. |
| Multi-tier approval chains | Most platforms support L1 → L2 → director approval chains (Pega, ServiceNow, Appian) | **Partial** — one approval tier only. States can add intermediate states via overlay, but no baseline pattern exists. |
| Parallel task processing | Fork/join patterns allowing multiple tasks to run concurrently for the same case (ServiceNow, Pega, Appian, Curam) | **Not in scope** — parallel sub-tasks within a case are a case management domain concern. |
| Task dependencies | Blocking one task on completion of another (ServiceNow, JSM, Pega) | **Planned** — see issue #195. |
| Compensating transactions / rollback | If a transition's side effects fail partially, roll back to the prior state (Pega, Appian, ServiceNow) | **Adapter layer** — partial failure recovery is an implementation concern. |
| Retry logic for automated steps | Automatic retry with backoff when automated effects fail (all enterprise platforms) | **Adapter layer** — retry behavior is an infrastructure concern. |

### Routing and assignment

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Skill-based routing | Route to agents matching required skills (JSM, ServiceNow, Pega, Appian) | **Planned** — see issue #199. |
| Workload-based routing | Route to least-loaded or most-available agent (ServiceNow, Appian Workload Balance, Pega Get Next Work) | **Planned** — see issue #198. |
| Named routing strategies | Explicit strategies: round-robin, least-loaded, shared queue (Appian Automated Case Routing, ServiceNow) | **Planned** — see issue #198. |
| Pull routing / Get Next Work | Worker requests their next best assignment; system selects based on urgency, skills, and availability (Pega Get Next Work) | **Planned** — see issue #196. |
| Delegation / out-of-office routing | When a caseworker is unavailable, tasks automatically redirect to a substitute or back to the queue (JSM, ServiceNow, Pega, Appian, Salesforce) | **Planned** — see issue #188. |
| Overflow routing | When a queue exceeds capacity, tasks overflow to a backup queue (JSM, ServiceNow, Pega) | **Adapter layer** — high-volume routing logic is an adapter concern. |
| Bulk reassignment | Supervisor reassigns multiple tasks at once (JSM, ServiceNow, Curam) | **Planned** — see issue #183. |
| Weighted priority scoring | Multi-factor priority scoring combining urgency, program type, age, and other attributes into a numeric score (Pega Urgency 1–100, ServiceNow urgency × impact) | **Planned** — see issue #200. |
| Delegation / identity acting-as | One user acting on behalf of another with a dual-identity audit trail (JSM, ServiceNow, Pega) | **Not in scope** — a cross-cutting platform concern resolved before the state machine sees the request. See issue #181. |

### SLA and deadline management

| Capability | Industry standard | Blueprint status |
|---|---|---|
| SLA goal tier | Soft performance target separate from the hard deadline — Goal / Deadline / Passed Deadline (Pega three-tier) | **Planned** — see issue #189. |
| Holiday calendar management | Agency-specific holiday calendars excluding non-working days from SLA calculations (JSM, ServiceNow, Pega, Appian, Salesforce) | **Planned** — federal holiday exclusion is required for correct regulatory deadline calculation. See issue #190. |
| SLA retroactive recalculation | When task attributes change after creation (e.g., `isExpedited` is set), SLA deadlines are recalculated (ServiceNow, Pega, Curam) | **Planned** — see issue #191. |
| Deadline extensions | Formal process for extending a deadline with documented justification (ServiceNow, Curam, Pega) | **Planned** — see issue #192. |
| Grace period handling | A defined window after the deadline before adverse action — common in SNAP and Medicaid processing | **Planned** — see issue #197. |

### Task structure and types

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Task-to-record linkage | Tasks associated with the case, application, or entity they are about (JSM, ServiceNow, Curam, Pega) | **Supported** — polymorphic `subjectType`/`subjectId` pair on Task. States extend the `subjectType` enum via overlay. |
| Task type differentiation by program | Different programs (SNAP, Medicaid, TANF) have different task schemas, required fields, and workflows (Curam, Pega, Appian, ServiceNow) | **Planned** — see issue #193. |
| Task notes / comments | User-authored notes on a task (Pega, Appian, ServiceNow, JSM) | **Not in scope** — notes belong on the case, not the task. Owned by the [Case Management](case-management.md) domain. |
| Task checklists / sub-items | Required steps or document checklists within a task (ServiceNow, Appian, JSM) | **Not in scope** for the baseline. |
| Task templates | Pre-defined task configurations for recurring work types (ServiceNow, JSM, Pega, Appian) | **Not in scope** for the baseline. |

### Access control

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Role enforcement | Roles enforced by platform middleware on every operation | **Not in scope** — authentication and caller context injection is a cross-cutting platform concern. Guard stubs are the contract integration points. |
| Field-level access control | Caseworkers can view but not edit certain fields; supervisors see additional fields; sensitive data masked by role (all major platforms) | **Not in scope** — a cross-cutting RBAC platform concern, not per-domain. |
| Confidential / sensitive case handling | Domestic violence address confidentiality, restricted-access cases, need-to-know enforcement (Curam, ServiceNow, Salesforce) | **Not in scope** — confidentiality is a property of the case. Owned by the [Case Management](case-management.md) domain. |
| Read access logging | Logging who viewed sensitive task data (PII/PHI) — required for HIPAA and federal QC (Curam, ServiceNow, Salesforce) | **Not in scope** — a cross-cutting platform infrastructure concern. |

### Integration and events

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Event-triggered task creation | Tasks auto-created when domain events fire (e.g., application submitted → review task) | **Planned** — event infrastructure is in place; the wiring that maps incoming events to task creation is not yet implemented. See issue #163. |
| Real-time event streaming / webhooks | Push notifications to external subscribers when events fire (JSM webhooks, ServiceNow Event Management, Pega, Appian) | **Not in scope** — a cross-cutting platform concern; real-time delivery should not be duplicated per domain. |
| Event replay | Ability to replay past events for debugging or migrating to a new system (ServiceNow, Pega, Appian) | **Not in scope** — a cross-cutting platform operations concern. |
| Notification on state change | Configurable push notifications on escalation, block, completion, etc. | **Not in scope** — handled by the [communications domain](../cross-cutting/communication.md), which subscribes to domain events. |

### Reporting and analytics

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Operational reporting | Built-in reports on caseload, productivity, backlog, and team performance (JSM, ServiceNow, Pega, Appian, Curam) | **Not in scope** — a reporting-domain concern. Workflow metrics provide the raw data; report generation is out of scope. |
| Staffing forecasting | Predictive models for upcoming workload and staffing needs based on historical trends (Pega, ServiceNow, Curam) | **Not in scope** — a reporting-domain concern. |

### Compliance and government-specific

| Capability | Industry standard | Blueprint status |
|---|---|---|
| Federal reporting exports | Structured exports for SNAP (FNS-388), Medicaid (T-MSIS), and other federal reporting requirements (Curam, Pega, ServiceNow) | **Not in scope** — a reporting-domain concern. |
| Fair hearing / appeals tracking | Dedicated workflow for applicant appeals with hearing date scheduling, statutory deadlines, and outcome tracking (Curam, Pega, ServiceNow) | **Planned** — depends on issue #193 (task type as lifecycle discriminator). |
| Change of circumstance handling | When household composition, income, or program status changes mid-case, associated tasks are automatically created or updated (Curam, Pega) | **Not in scope** — handled via cross-domain event wiring (see issue #163). |
| Overpayment / recoupment tracking | Tracking and recovering benefits paid in error, including repayment schedules and federal reporting (Curam, Pega) | **Not in scope** — a case management or financial domain concern. |

---

## References

### Systems and platforms compared

| System | Description |
|---|---|
| [Atlassian Jira Service Management (JSM)](https://www.atlassian.com/software/jira/service-management) | IT service management platform with configurable workflows, automation rules, and SLA tracking. Widely used in government IT operations. |
| [ServiceNow](https://www.servicenow.com/) | Enterprise workflow and service management platform. Leading government adopter; strong SLA, timer, escalation, and notification features. |
| [IBM Curam](https://www.ibm.com/products/curam-social-program-management) | Social program management platform purpose-built for benefits administration (SNAP, Medicaid, TANF). Used by several U.S. states and international governments. |
| [Salesforce Government Cloud](https://www.salesforce.com/solutions/government/) | CRM and case management platform for public sector. FedRAMP authorized; used by several states for benefits case management and constituent services. |
| [Pegasystems (Pega)](https://www.pega.com/) | BPM and case management platform. Named a Leader in the Gartner Magic Quadrant for BPM-Platform-Based Case Management Frameworks; significant government and healthcare presence. Key docs: [Case Life Cycle Design](https://academy.pega.com/topic/case-life-cycle-design/v2), [SLAs](https://academy.pega.com/topic/service-level-agreements/v6), [Assignment Routing](https://academy.pega.com/topic/assignment-routing/v1), [Get Next Work](https://academy.pega.com/topic/get-next-work-feature/v1). |
| [Appian](https://appian.com/) | Low-code BPM and case management platform. Named a Leader in Gartner's LCAP and BPM Magic Quadrants; FedRAMP authorized. Key docs: [Case Management Studio](https://docs.appian.com/suite/help/26.2/case-management-studio-overview.html), [Automated Case Routing](https://docs.appian.com/suite/help/24.4/cms-automated-case-routing-overview.html), [KPIs](https://docs.appian.com/suite/help/25.4/process-custom-kpis.html), [Record Events](https://docs.appian.com/suite/help/25.4/record-events.html). |
| [Camunda](https://camunda.com/) | Open-source BPMN-native workflow and process orchestration engine. Useful reference for BPMN-aligned state machine and human task patterns. |
| [WfMC / WS-HumanTask](https://www.oasis-open.org/committees/tc_home.php?wg_abbrev=bpel4people) | OASIS standard for human task management in service-oriented architectures. Predecessor to modern task API patterns; referenced for WS-HumanTask state model. |

### Standards and specifications

| Standard | Description |
|---|---|
| [BPMN 2.0](https://www.omg.org/spec/BPMN/2.0/) | Business Process Model and Notation — OMG industry standard for process modeling. |
| [JSON Logic](https://jsonlogic.com/) | Portable rule/expression format used in the blueprint for guards, rule conditions, and metric filters. |
| [OpenAPI 3.x](https://spec.openapis.org/oas/v3.1.0) | API specification standard used for all blueprint contract artifacts. |

### Federal regulatory references

| Regulation | Description |
|---|---|
| [7 CFR Part 273](https://www.ecfr.gov/current/title-7/subtitle-B/chapter-II/subchapter-C/part-273) | SNAP program regulations — processing timelines, quality control requirements, and the basis for blueprint SLA deadlines (7-day expedited, 30-day standard). |
| [42 CFR Part 435](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-C/part-435) | Medicaid eligibility regulations — 45-day processing requirement for most Medicaid; 90-day for disability-related determinations. |
