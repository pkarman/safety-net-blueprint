# Metrics

Operational metrics are defined as behavioral contract artifacts (`*-metrics.yaml`) and served by a cross-cutting API (`GET /metrics`, `GET /metrics/{metricId}`). They are computed on demand from live data — not pre-aggregated or stored separately.

See [Workflow Metrics](../domains/workflow.md) for the domain-specific baseline and [Mock Server](../../guides/mock-server.md) for how to query metrics in development.

---

## Data Model

Each metric definition in a `*-metrics.yaml` file has:

| Field | Purpose |
|-------|---------|
| `id` | Unique identifier (used as the URL path segment) |
| `name` | Human-readable display name |
| `description` | What the metric measures |
| `aggregate` | Computation type: `count`, `ratio`, or `duration` |
| `source` | Data source for the metric (collection + JSON Logic filter) |
| `total` | For `ratio` only — denominator data source |
| `from` / `to` | For `duration` only — start and end event sources |
| `pairBy` | For `duration` only — field to correlate start and end events |
| `targets` | Performance targets (stat, operator, threshold) |

---

## Aggregate Types

### `count`

Counts resources matching a filter condition.

```yaml
aggregate: count
source:
  collection: tasks
  filter:
    "==":
      - var: status
      - pending
```

### `ratio`

Numerator count divided by denominator count, expressed as a percentage.

```yaml
aggregate: ratio
source:
  collection: events
  filter:
    "==":
      - var: action
      - released
total:
  collection: events
```

### `duration`

Median (or other percentile) elapsed time between paired events. Uses `from` and `to` source definitions rather than a single `source`, plus a `pairBy` field to match start events to their corresponding end events.

```yaml
aggregate: duration
from:
  collection: events
  filter:
    "==":
      - var: action
      - created
to:
  collection: events
  filter:
    "==":
      - var: action
      - claimed
pairBy: objectId
```

---

## JSON Logic Filters

All `filter` fields in metric definitions use [JSON Logic](https://jsonlogic.com/) expressions — the same evaluator used in state machine guards and rule conditions.

Filters operate on individual records in the collection. A record is included if the filter expression evaluates to `true` for that record.

**Examples:**

```yaml
# Match tasks in a specific status
filter:
  "==":
    - var: status
    - pending

# Match events with a specific action
filter:
  "==":
    - var: action
    - auto-escalate-sla-warning

# Match tasks with at least one breached SLA entry
filter:
  in:
    - breached
    - var: slaInfo.*.status
```

---

## `pairBy` vs `groupBy`

These serve different purposes and should not be confused:

| | `pairBy` | `groupBy` |
|---|---|---|
| **Where defined** | `*-metrics.yaml` (part of the metric definition) | Query parameter on `GET /metrics` |
| **Purpose** | Correlates `from` and `to` events for duration metrics | Breaks down computed metric values by a field |
| **Example** | `pairBy: objectId` — pairs a `created` event with a `claimed` event for the same task | `groupBy=queueId` — returns one metric value per queue |

`pairBy` is structural — it defines how the metric is calculated. `groupBy` is analytical — it splits the result for comparison.

---

## GET /metrics API

The metrics API is cross-cutting — it is not scoped to a single domain and can return metrics from any `*-metrics.yaml` file.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/metrics` | List all metrics with current values |
| `GET` | `/metrics/{metricId}` | Get a single metric with current value |

### Query Parameters

| Parameter | Description |
|-----------|-------------|
| `q` | Search by metric name |
| `domain` | Filter to metrics from a specific domain (e.g., `workflow`) |
| `groupBy` | Field to break down values (e.g., `queueId`, `program`) |
| `from` | Start of time window (ISO datetime) |
| `to` | End of time window (ISO datetime) |
| `queueId` | Pre-filter source data to a specific queue |
| `program` | Pre-filter source data to a specific program |
| `limit` | Max items to return |
| `offset` | Pagination offset |

### Response Shape

Without `groupBy`:

```json
{
  "id": "tasks_in_queue",
  "name": "Tasks in Queue",
  "description": "Number of tasks currently in pending status.",
  "aggregate": "count",
  "value": 42,
  "breakdown": null
}
```

With `groupBy=queueId`:

```json
{
  "id": "tasks_in_queue",
  "name": "Tasks in Queue",
  "description": "Number of tasks currently in pending status.",
  "aggregate": "count",
  "value": 42,
  "breakdown": {
    "snap-intake": 18,
    "medicaid-intake": 14,
    "expedited": 10
  }
}
```

`value` is always the aggregate across all data (ignoring `groupBy`). `breakdown` is `null` when no `groupBy` is requested.

---

## Metrics vs. Per-Task SLA Info

These are distinct concepts:

| | `slaInfo` on tasks | Metrics |
|---|---|---|
| **Scope** | Per task — one entry per assigned SLA type | Aggregate across all tasks |
| **Updated** | On every state transition | Computed on demand |
| **Access** | `GET /tasks/{id}` — embedded in the task resource | `GET /metrics` |
| **Purpose** | Track this task's deadline and clock status | Monitor program-wide performance |

`slaInfo` answers "what is the SLA status of this specific task?" Metrics answer "what fraction of tasks across the program are breaching SLAs?"

---

## Cross-Artifact Validation

The `action` values used in metric `filter` expressions are validated against the state machine transition IDs. If a filter references `action: auto-escalate-sla-warning`, that action must exist as a transition in the corresponding `*-state-machine.yaml`. This check prevents metrics from silently measuring events that never fire.

---

## Customization

States will be able to customize metrics via overlay once issue #174 lands. Until then, `*-metrics.yaml` files can be replaced directly in a state's fork of the contracts:

- Override `targets` to reflect state-specific performance goals
- Add state-specific metrics (e.g., metrics scoped to a program not in the baseline)
- Remove baseline metrics that do not apply to the state's program mix
