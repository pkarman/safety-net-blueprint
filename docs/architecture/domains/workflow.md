# Workflow Domain

The Workflow domain manages the lifecycle of work items (tasks), their routing to queues, SLA tracking against regulatory deadlines, and operational metrics. It is a **behavior-shaped** domain — the task lifecycle is governed by a state machine with guards, effects, and routing rules rather than ad-hoc CRUD logic.

See [Domain Design Overview](../domain-design.md) for context and [Contract-Driven Architecture](../contract-driven-architecture.md) for the contract approach.

## Domain Model

### Task

A task is the atomic unit of caseworker activity — reviewing an application, verifying a document, completing a redetermination. It represents a single, ownable piece of work with a clear beginning and end. Tasks are assigned to a single owner (caseworker, supervisor, or automated process) at a time and have an explicit lifecycle governed by the [state machine](#state-machine). They carry `slaInfo` entries that track deadline status against regulatory requirements, and link to a `Queue` that controls routing and visibility. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### Queue

Queues are the organizing structure for caseworker workloads. A queue represents a logical grouping of tasks — typically by program (SNAP, Medicaid), team, or skill — and determines which workers can see and claim which tasks. Tasks enter a queue automatically when created or released, based on assignment rules. Supervisors manage queues to balance workload across their teams. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### Domain Events

Every state machine transition and lifecycle hook emits an immutable domain event. Events serve two purposes: they are the audit trail (a complete history of what happened to every task and when) and the integration surface for cross-domain communication (other domains subscribe to workflow events rather than polling task state). For example, when a task transitions to `completed`, an event is emitted that could trigger downstream processes like application status updates or case record creation. All domains share the same events collection; `domain`, `resource`, and `action` identify the event type. Read-only API. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### State Machine

The task lifecycle is governed by a declarative state machine (`workflow-state-machine.yaml`) rather than ad-hoc endpoint logic. Tasks move through states like `pending` → `in_progress` → `awaiting_client` → `in_progress` → `completed`, with each transition triggered by an explicit action (claim, release, complete, await-client, etc.). Each transition trigger becomes an RPC endpoint (e.g., `POST /workflow/tasks/{id}/claim`). Transitions declare guards (preconditions that must be true for the transition to be allowed) and effects (side effects that execute when the transition fires, such as updating fields or emitting events) — adding a new transition is a YAML table row, not new endpoint code. [Spec: `workflow-state-machine.yaml`](../../../packages/contracts/workflow-state-machine.yaml)

For the full state transition table, guard definitions, and effect specifications see [workflow-state-machine.yaml](../../../packages/contracts/workflow-state-machine.yaml) and [State machine](workflow-design-rationale.md#state-machine) in the design reference.

### Rules

Assignment and priority rules express routing logic that doesn't belong in the state machine. When a task is created or returns to `pending` (e.g., after a release or escalation), rules determine which queue it should go to and what priority it should have. Keeping this logic in a separate rules file means states can replace their routing and priority logic entirely without touching the state machine.

| Rule Set | Purpose |
|----------|---------|
| `assignment` | Route tasks to the correct queue based on program type and other criteria |
| `priority` | Set task priority (e.g., `expedited` when `isExpedited == true`) |

Rules use JSON Logic conditions and `first-match-wins` evaluation. The baseline rules are illustrative — states replace them with their own program-specific routing logic. See [Rules Engine](workflow-design-rationale.md#rules-engine) in the design reference.

### SLA Types

Federal regulations impose strict processing deadlines on benefits applications — 7 days for expedited SNAP, 30 days for standard SNAP, 45 days for most Medicaid, 90 days for disability-related Medicaid. SLA types define these deadlines and the conditions under which the clock pauses (e.g., while waiting on the client) and resumes. Each task carries a `slaInfo` array with one entry per applicable SLA type, tracking deadline status in real time. SLA types are auto-assigned at task creation based on the task's fields and updated automatically on every state transition.

Baseline SLA types: `snap_expedited` (7 days), `snap_standard` (30 days), `medicaid_standard` (45 days), `medicaid_disability` (90 days). Defined in [`workflow-sla-types.yaml`](../../../packages/contracts/workflow-sla-types.yaml). See [SLA and deadline management](workflow-design-rationale.md#sla-and-deadline-management) for design rationale.

### Metrics

Operational metrics give supervisors visibility into queue health, team performance, and compliance risk. Metrics are computed on demand from live task and event data — no separate reporting store. Each metric is defined declaratively in [`workflow-metrics.yaml`](../../../packages/contracts/workflow-metrics.yaml) using a `source + aggregate + JSON Logic filter` model: specify what data to query, how to aggregate it, and optionally what performance target to evaluate against. Results are available at `GET /workflow/metrics` with support for time windowing and dimensional breakdown by queue or program. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

Baseline metrics: task time to claim (duration), tasks in queue (count), release rate (ratio), SLA breach rate (ratio), SLA warning rate (ratio). See [Metrics](workflow-design-rationale.md#metrics) for design rationale.

## Customization

The baseline contracts are a starting point. States customize via overlays:

- **State machine**: add transitions, extend guards, add effects to existing transitions
- **Multiple lifecycles**: add task-type-specific states and transitions to the state machine, scoped via `taskType` guards, to support multiple lifecycles within the same domain (e.g., fair hearing tasks alongside standard casework tasks) — see issue #193
- **Rules**: replace `workflow-rules.yaml` entirely with state-specific assignment and priority logic
- **SLA types**: replace or extend `workflow-sla-types.yaml` with state-specific deadlines and pause conditions (overlay support: issue #174)
- **Metrics**: replace or extend `workflow-metrics.yaml` with state-specific metrics and targets (overlay support: issue #174)

See the [State Overlays Guide](../../guides/state-overlays.md) for overlay mechanics.

## Future Work

| Capability | Notes |
|------------|-------|
| Polymorphic subject association | Tasks should link to applications, cases, and other entities via `subjectId`/`subjectType` rather than entity-specific FK fields. See issue #177. |
| Cross-domain event wiring | Application submitted → review task auto-created. Events infrastructure is in place; wiring that maps domain events to task creation is not yet implemented. |
| Role-based access control | Guards reference `$caller.role` and `$caller.type`; enforcement is at the service layer until RBAC is implemented. |
| Overlay support for behavioral YAMLs | States can't yet overlay `*-sla-types.yaml`, `*-metrics.yaml`, or `*-state-machine.yaml`. See issue #174. |
| Named routing strategies + skill-based assignment | Queue `routingStrategy` field; rules support skill-based routing but no built-in round-robin or least-loaded routing actions yet. See issue #162. |
| Pull routing (claim-next) | `POST /workflow/queues/{id}/claim-next` — atomically select and claim the next best task. See issue #196. |
| Task dependencies | `dependsOnTaskId` field, `awaiting_prerequisite` state, event-triggered unblocking when dependency completes. See issue #195. |
| Task type as lifecycle discriminator | `taskType` field enabling multiple lifecycles (e.g., fair hearing) within the same state machine via guards. See issue #193. |
| Delegation / out-of-office routing | Contract point for absence coverage so tasks auto-redirect when a caseworker is unavailable. See issue #188. |
| SLA goal tier | Soft performance target (Goal) alongside the hard deadline, following Pega's three-tier model. See issue #189. |
| Holiday calendar support | Agency-specific holiday exclusions for `calendarType: business` SLA calculations. See issue #190. |
| SLA deadline recalculation on attribute change | Recalculate SLA deadlines when `isExpedited` or `programType` changes via `onUpdate`. See issue #191. |
| Deadline extensions | `extend-deadline` transition with required justification and audit event. See issue #192. |
| Grace period timer | Baseline `auto-adverse-action` timer (`after: 0d`) as an explicit overlay point for post-deadline grace periods. See issue #197. |

For a comprehensive gap assessment including items out of scope and delegated to the platform layer, see [Known Gaps and Future Considerations](workflow-design-rationale.md#known-gaps-and-future-considerations) in the design reference.

## Contract Artifacts

| Artifact | File |
|----------|------|
| OpenAPI spec | `workflow-openapi.yaml` — Tasks, Queues, Events, Metrics |
| State machine | `workflow-state-machine.yaml` — 8 states, 21 transitions (including 4 timer-triggered), guards, effects |
| Rules | `workflow-rules.yaml` — Assignment and priority rule sets |
| SLA types | `workflow-sla-types.yaml` — 4 baseline SLA types |
| Metrics | `workflow-metrics.yaml` — 5 baseline metrics |

## Related Documents

| Document | Description |
|----------|-------------|
| [Workflow Design Reference](workflow-design-rationale.md) | Industry reference: vendor comparisons, design decisions, customization points, and comprehensive gap assessment |
| [Workflow Prototype](../../prototypes/workflow-prototype.md) | Full design spec — states, transitions, rules, metrics |
| [Domain Design](../domain-design.md) | Workflow section in the domain overview |
| [Case Management](case-management.md) | Staff, teams, offices — closely related domain |
| [Scheduling](scheduling.md) | Appointments may trigger workflow tasks |
| [Contract-Driven Architecture](../contract-driven-architecture.md) | Contract artifacts and the adapter pattern |
