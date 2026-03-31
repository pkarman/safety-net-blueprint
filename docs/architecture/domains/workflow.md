# Workflow Domain

The Workflow domain manages the lifecycle of work items (tasks), their routing to queues, SLA tracking against regulatory deadlines, and operational metrics. It is a **behavior-shaped** domain — the task lifecycle is governed by a state machine with guards, effects, and routing rules rather than ad-hoc CRUD logic.

See [Domain Design Overview](../domain-design.md) for context and [Contract-Driven Architecture](../contract-driven-architecture.md) for the contract approach.

## Domain Model

### Task

A discrete unit of work assigned to a caseworker, supervisor, or automated process. Tasks have an explicit lifecycle governed by the [state machine](#state-machine) and carry `slaInfo` tracking entries (one per assigned SLA type) updated automatically on every transition. Tasks link to a `Queue` that determines routing and visibility. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### Queue

Work queues organize tasks by program type, team, or skill. Tasks are routed into queues automatically by assignment rules and re-routed when released back to `pending`. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### Domain Events

Immutable records emitted on every state machine transition and lifecycle hook. Events are the audit trail and the integration surface for cross-domain communication — other domains subscribe to workflow events rather than polling task state. All domains share the same events collection; `domain`, `resource`, and `action` identify the event type. Read-only API. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

### State Machine

The task lifecycle is governed by a declarative state machine (`workflow-state-machine.yaml`) with 9 states and 12 transitions. Each transition trigger becomes an RPC endpoint (e.g., `POST /workflow/tasks/{id}/claim`). Transitions declare guards (preconditions) and effects (side effects) — no ad-hoc endpoint code. [Spec: `workflow-state-machine.yaml`](../../../packages/contracts/workflow-state-machine.yaml)

For the full state transition table, guard definitions, and effect specifications see [workflow-state-machine.yaml](../../../packages/contracts/workflow-state-machine.yaml) and [Task Lifecycle States](workflow-design-reference.md#task-lifecycle-states) in the design reference.

### Rules

Assignment and priority rules route tasks to the correct queue and set their priority without hardcoding logic in the state machine. Rules are evaluated automatically at task creation and on re-entry to the queue (e.g., after release or escalation). [Spec: `workflow-rules.yaml`](../../../packages/contracts/workflow-rules.yaml)

| Rule Set | Purpose |
|----------|---------|
| `assignment` | Route tasks to the correct queue based on program type and other criteria |
| `priority` | Set task priority (e.g., `expedited` when `isExpedited == true`) |

Rules use JSON Logic conditions and `first-match-wins` evaluation. The baseline rules are illustrative — states replace them with their own program-specific routing logic. See [Rules Engine](workflow-design-reference.md#rules-engine) in the design reference.

### SLA Types

Program-specific processing deadlines and the conditions under which the SLA clock pauses or resumes. Defined in [`workflow-sla-types.yaml`](../../../packages/contracts/workflow-sla-types.yaml). SLA types are auto-assigned at task creation via `autoAssignWhen` conditions and tracked per-task in the `slaInfo` array. The clock pauses when `pauseWhen` conditions match (e.g., `awaiting_client`) and resumes automatically on state change.

Baseline SLA types: `snap_expedited` (7 days), `snap_standard` (30 days), `medicaid_standard` (45 days), `medicaid_disability` (90 days). See [SLA Types and Clock Management](workflow-design-reference.md#sla-types-and-clock-management) for design rationale.

### Metrics

Computed operational metrics derived from live task and event data. Defined in [`workflow-metrics.yaml`](../../../packages/contracts/workflow-metrics.yaml) using a decomposed `source + aggregate + JSON Logic filter` model. Served read-only at `GET /workflow/metrics` and `GET /workflow/metrics/{metricId}`. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

Baseline metrics: task time to claim (duration), tasks in queue (count), release rate (ratio), SLA breach rate (ratio), SLA warning rate (ratio). See [Metrics](workflow-design-reference.md#metrics) for design rationale.

## Customization

The baseline contracts are a starting point. States customize via overlays:

- **State machine**: add transitions, extend guards, add effects to existing transitions
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
| SLA breach transition | `slaInfo.*.status` becomes `breached` via the SLA engine; no timer-triggered state machine transition fires at the breach moment. See [Known gaps](workflow-design-reference.md#known-gaps-and-future-considerations). |
| Skill-based assignment | Rules support it; no built-in assignment actions yet for round-robin or least-loaded routing. |

## Contract Artifacts

| Artifact | File |
|----------|------|
| OpenAPI spec | `workflow-openapi.yaml` — Tasks, Queues, Events, Metrics |
| State machine | `workflow-state-machine.yaml` — 9 states, 12 transitions, guards, effects |
| Rules | `workflow-rules.yaml` — Assignment and priority rule sets |
| SLA types | `workflow-sla-types.yaml` — 4 baseline SLA types |
| Metrics | `workflow-metrics.yaml` — 5 baseline metrics |

## Related Documents

| Document | Description |
|----------|-------------|
| [Workflow Design Reference](workflow-design-reference.md) | Feature-by-feature reference: vendor comparisons, design decisions, customization points |
| [Workflow Prototype](../../prototypes/workflow-prototype.md) | Full design spec — states, transitions, rules, metrics |
| [Domain Design](../domain-design.md) | Workflow section in the domain overview |
| [Case Management](case-management.md) | Staff, teams, offices — closely related domain |
| [Scheduling](scheduling.md) | Appointments may trigger workflow tasks |
| [Contract-Driven Architecture](../contract-driven-architecture.md) | Contract artifacts and the adapter pattern |
