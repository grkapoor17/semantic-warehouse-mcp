# query_metrics patterns

Copy a pattern and swap in metric and dimension names from `list_metrics` / `list_dimensions`.
Examples use the FPL example warehouse in `examples/fpl`.

## Top N by a total

```json
{
  "metrics": ["total_points", "goals"],
  "group_by": ["player__player_name"],
  "where": [{"field": "player_fixture__season", "op": "=", "value": "2024-25"}],
  "order_by": [{"field": "total_points", "descending": true}, {"field": "player__player_name"}],
  "limit": 10
}
```

The second `order_by` entry breaks ties so the ranking doesn't depend on chance.

## Top N by a rate, with a minimum sample

Always include the volume metric and filter it with `having`. Otherwise someone who played 12 minutes tops the list.

```json
{
  "metrics": ["points_per_90", "minutes_played"],
  "group_by": ["player__player_name"],
  "where": [{"field": "player_fixture__season", "op": "=", "value": "2024-25"}],
  "having": [{"field": "minutes_played", "op": ">=", "value": 1500}],
  "order_by": [{"field": "points_per_90", "descending": true}],
  "limit": 10
}
```

## Time series

```json
{
  "metrics": ["goals_per_match"],
  "group_by": ["metric_time__month"],
  "where": [{"field": "metric_time", "op": ">=", "value": "2023-08-01"}],
  "order_by": [{"field": "metric_time__month"}]
}
```

`metric_time` is each metric's own time dimension, so metrics from different tables line up on it.

## Compare segments

Group by the segment and filter to the segments you want:

```json
{
  "metrics": ["total_points", "appearances", "points_per_appearance"],
  "group_by": ["player_fixture__was_home"],
  "where": [{"field": "player__player_name", "op": "=", "value": "Mohamed Salah"}]
}
```

## Share of total

Two calls: the breakdown, then the same query without the group-by. Divide yourself and show both numbers.

```json
{"metrics": ["goals"], "group_by": ["player_fixture__position"], "where": [{"field": "player_fixture__season", "op": "=", "value": "2025-26"}]}
{"metrics": ["goals"], "where": [{"field": "player_fixture__season", "op": "=", "value": "2025-26"}]}
```

## Period over period

Group by the period and compare adjacent rows. Don't run two separate queries with hand-typed dates.

```json
{
  "metrics": ["total_points"],
  "group_by": ["player_fixture__season"],
  "where": [{"field": "player__player_name", "op": "=", "value": "Cole Palmer"}],
  "order_by": [{"field": "player_fixture__season"}]
}
```

## Find the exact value to filter on

```json
{
  "metrics": ["appearances"],
  "group_by": ["player", "player__player_name"],
  "where": [{"field": "player__player_name", "op": "ilike", "value": "%palacios%"}]
}
```

Several rows mean several entities. Group by the entity key (`player`) from then on, or ask which one the user means.
