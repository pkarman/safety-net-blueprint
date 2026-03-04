# Workflow Domain

> **Status:** Task and TaskAuditEvent APIs implemented (alpha). State machine engine supports transitions, guards, `set` and `create` effects. Rules, metrics, and additional entities are future work.

See [Domain Design Overview](../domain-design.md) for context and [Contract-Driven Architecture](../contract-driven-architecture.md) for the contract approach.

## Overview

The Workflow domain manages work items, tasks, SLA tracking, and task routing. It is a **behavior-shaped** domain — the task lifecycle involves state transitions, guards, effects, routing rules, and SLA enforcement.

## Current Implementation

| Entity | Description | Spec |
|--------|-------------|------|
| **Task** | A discrete unit of work with a lifecycle | [`workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml) |
| **TaskAuditEvent** | Immutable audit trail, created automatically by transition effects (read-only API) | [`workflow-openapi.yaml`](../../../packages/contracts/workflow-openapi.yaml) |

**State machine:** 3 states (`pending`, `in_progress`, `completed`), 4 transitions (`create`, `claim`, `complete`, `release`) with guards and `set`/`create` effects. See [`workflow-state-machine.yaml`](../../../packages/contracts/workflow-state-machine.yaml).

**Key design decisions:**
- Explicit status over derived state — industry standard across WS-HumanTask, Camunda, ServiceNow, and BPMN.
- Single-owner assignment — follows WS-HumanTask's `actualOwner` pattern. Group/queue assignment is future work.
- Minimal status enum — the base set maps to the universal core of every task system. States extend via overlay.
- Read-only audit trail — audit events are created as transition side effects, not by API consumers.

## Future Work

### Remaining entities

| Entity | Purpose |
|--------|---------|
| **Queue** | Routes tasks to groups by team/program/skill |
| **TaskType** | Task categorization and default config |
| **SLAType** | SLA deadline config by program and task type |
| **VerificationTask** | Verify data against external sources |
| **VerificationSource** | External verification API registry |

### Remaining state machine capabilities

- 6 additional states: `awaiting_client`, `awaiting_verification`, `awaiting_review`, `returned_to_queue`, `cancelled`, `escalated`
- 8 additional transitions (escalate, reassign, cancel, etc.) using the same effect patterns
- Additional effect types: `lookup`, `evaluate-rules`, `event`
- SLA clock behavior (pause on awaiting states)
- Additional Task fields: priority, queue, program type, SLA tracking, subtasks, dependencies

### Rules and metrics

- Assignment and priority rules as decision tables (see [workflow prototype](../../prototypes/workflow-prototype.md))
- Operational metrics: time to claim, queue depth, release rate, SLA breach rate

## Contract Artifacts

| Artifact | Status | Notes |
|----------|--------|-------|
| OpenAPI spec | Alpha | Task CRUD + TaskAuditEvent (read-only) |
| State machine YAML | Alpha | 4 transitions with guards, `set`/`create` effects. 8 more planned |
| Rules YAML | Draft | Designed in prototype, not yet implemented |
| Metrics YAML | Draft | Designed in prototype, not yet implemented |

## Key Design Questions

- **Verification workflow** — Should VerificationTask be a separate state machine or nested states within the main task lifecycle?
- **Cross-domain rule context** — How do rules reference `application.*` or `case.*` data?
- **Batch operations** — How should bulk reassignment work?
- **Skill matching strategies** — How do `round_robin`, `least_loaded`, and `skill_match` assignment actions work?
- **Notification effects** — What triggers notifications beyond escalation?

## Related Documents

| Document | Description |
|----------|-------------|
| [Workflow Prototype](../../prototypes/workflow-prototype.md) | Full design — 9 states, 12 transitions, rules, metrics |
| [Domain Design](../domain-design.md) | Workflow section in the domain overview |
| [Case Management](case-management.md) | Staff, teams, offices — closely related domain |
| [Scheduling](scheduling.md) | Appointments may trigger workflow tasks |
| [Contract-Driven Architecture](../contract-driven-architecture.md) | Contract artifacts and the adapter pattern |
