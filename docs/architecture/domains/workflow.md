# Workflow Domain

> **Status:** Task and TaskAuditEvent APIs implemented (alpha). State machine engine supports transitions, guards, `set` and `create` effects. Additional fields, entities, and behavioral artifacts (rules, metrics, events) are future work. The [workflow prototype](../../prototypes/workflow-prototype.md) designs the full set of patterns.

See [Domain Design Overview](../domain-design.md) for context and [Contract-Driven Architecture](../contract-driven-architecture.md) for the contract approach.

## Overview

The Workflow domain manages work items, tasks, SLA tracking, and task routing. It is a **behavior-shaped** domain — the task lifecycle involves state transitions, guards, effects, routing rules, and SLA enforcement.

## Current Implementation

### Task

A discrete unit of work with a lifecycle. [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

Based on: [WS-HumanTask](https://docs.oasis-open.org/bpel4people/ws-humantask-1.1-spec-cs-01.html), [Camunda Tasklist](https://docs.camunda.io/docs/apis-tools/tasklist-api-rest/controllers/tasklist-api-rest-task-controller/), ServiceNow Task, [BPMN](https://www.bpmn.org/) task states.

**Key design decisions:**
- Explicit status over derived state — all four systems model task state as an explicit field, not derived from timestamps.
- Single-owner assignment — follows WS-HumanTask's `actualOwner` pattern. Group/queue assignment is future work.
- Minimal status enum — the base set (`pending`, `in_progress`, `completed`) maps to the universal core of every task system. States extend via overlay.

### TaskAuditEvent

Immutable audit trail for task state transitions. Created automatically by the state machine engine's `create` effects — read-only API (no POST/PATCH/DELETE). [Spec: `workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml)

| Concept | Industry Source |
|---------|----------------|
| Task event history | [WfMC](https://www.aiai.ed.ac.uk/project/wfmc/ARCHIVE/DOCS/refmodel/rmv1-16.html): Task Event History |
| Operation log | Camunda: [User Operation Log](https://docs.camunda.org/manual/latest/user-guide/process-engine/history/user-operation-log/) |
| Audit trail | [Flowable](https://documentation.flowable.com/latest/reactmodel/bpmn/reference/audit): Audit Trail |

## Future Work

### Additional Task Fields

Future fields include priority, queue assignment, program type, SLA tracking, subtasks, and dependencies. These are designed in the [workflow prototype](../../prototypes/workflow-prototype.md) and based on [WS-HumanTask](https://docs.oasis-open.org/bpel4people/ws-humantask-1.1-spec-cs-01.html), [WfMC](https://www.aiai.ed.ac.uk/project/wfmc/ARCHIVE/DOCS/refmodel/rmv1-16.html), [Camunda](https://docs.camunda.io/docs/apis-tools/tasklist-api-rest/controllers/tasklist-api-rest-task-controller/), ServiceNow, and [BPMN](https://www.bpmn.org/) patterns.

### Additional Entities

| Entity | Purpose | Industry Source |
|--------|---------|----------------|
| **Queue** | Routes tasks to groups by team/program/skill | WfMC: Worklist; ServiceNow: Assignment Group; Camunda: Candidate Groups |
| **TaskType** | Task categorization config | ServiceNow: Category; Camunda: Task Definition Key; WS-HumanTask: Task Definition |
| **SLAType** | SLA deadline config by program and task type | ServiceNow: [SLA Definition](https://www.emergys.com/blog/service-level-agreement-sla-for-servicenow/); WS-HumanTask: Deadline/Escalation |
| **VerificationTask** | Verify data against external sources | Benefits-domain-specific — no equivalent in generic workflow standards |
| **VerificationSource** | External verification API registry (IRS, ADP, state databases) | Benefits-domain-specific integration pattern |

### State Machine

The task lifecycle defines 12 transitions across 9 states. 4 transitions are implemented today (`create`, `claim`, `complete`, `release`) with guards and `set`/`create` effects working in the mock server. See [`workflow-state-machine.yaml`](../../../packages/contracts/workflow-state-machine.yaml). The remaining transitions use the same effect types and patterns.

**Implemented:** `pending`, `in_progress`, `completed` (3 states, 4 transitions including `onCreate`)

**Planned:** `awaiting_client`, `awaiting_verification`, `awaiting_review`, `returned_to_queue`, `cancelled`, `escalated` (6 additional states, 8 additional transitions)

Key behavioral patterns:
- Each transition trigger becomes an RPC API endpoint (e.g., `claim` -> `POST /workflow/tasks/:id/claim`)
- Guards enforce preconditions (e.g., task is unassigned, caller has required skills)
- Effects include: `set` (update fields), `create` (audit events), `lookup` (SLA config), `evaluate-rules` (routing), `event` (domain events)
- SLA clock pauses on `awaiting_client` and `awaiting_verification` states

### Rules

Assignment and priority rules are defined as decision tables using [JSON Logic](https://jsonlogic.com/). The prototype proves 2 assignment rules (SNAP-specific routing + catch-all) and 1 priority rule (expedited flag). See [workflow prototype](../../prototypes/workflow-prototype.md) for proven examples.

### Metrics

Four categories of operational metrics, with the prototype proving one metric from each source type:

| Category | Examples | Source Types |
|----------|----------|-------------|
| Task metrics | Time to claim, completion time, queue depth | Duration, state count |
| SLA metrics | Breach rate, at-risk count | Transition count, state count |
| Assignment metrics | Release rate, reassignment rate | Transition count |
| Verification metrics | Success rate, latency, match rate | Transition count, duration |

## Contract Artifacts

| Artifact | Status | Notes |
|----------|--------|-------|
| OpenAPI spec | Alpha | `workflow-openapi.yaml` — Task CRUD + TaskAuditEvent (read-only). Additional fields and entities in future issues |
| State machine YAML | Alpha | `workflow-state-machine.yaml` — 4 transitions with guards, `set`/`create` effects. 8 more planned. See [workflow prototype](../../prototypes/workflow-prototype.md) |
| Rules YAML | Draft | Assignment and priority rules; designed in prototype, not yet implemented |
| Metrics YAML | Draft | 4 metric categories; designed in prototype, not yet implemented |

## Key Design Questions

- **Verification workflow** — Should VerificationTask be a separate state machine or nested states within the main task lifecycle?
- **Cross-domain rule context** — How do rules reference `application.*` or `case.*` data? Requires context binding beyond `task.*`.
- **Batch operations** — How should bulk reassignment work? A `bulk-reassign` RPC trigger, or a batch REST endpoint?
- **Skill matching strategies** — How do `round_robin`, `least_loaded`, and `skill_match` assignment actions work as rule actions?
- **Notification effects** — What triggers notifications beyond escalation? SLA warnings? Assignment changes?

## Related Documents

| Document | Description |
|----------|-------------|
| [Workflow Prototype](../../prototypes/workflow-prototype.md) | Full design — 9 states, 12 transitions, rules, metrics |
| [Domain Design](../domain-design.md) | Workflow section in the domain overview |
| [Case Management](case-management.md) | Staff, teams, offices — closely related domain |
| [Scheduling](scheduling.md) | Appointments may trigger workflow tasks |
| [Contract-Driven Architecture](../contract-driven-architecture.md) | Contract artifacts and the adapter pattern |
