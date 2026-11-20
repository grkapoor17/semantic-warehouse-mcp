---
name: warehouse-analysis
description: Answer data questions against a warehouse exposed by the semantic-warehouse-mcp server (tools list_metrics, list_dimensions, query_metrics, list_tables, describe_table, run_query). Use when the user asks for numbers, rankings, trends, comparisons or breakdowns from their warehouse or dbt project, e.g. "who scored the most points", "revenue by month", "how many X last season". Covers choosing metrics over hand-written SQL, resolving exact names before filtering, small-sample and grain pitfalls, and how to report the answer.
---

# Warehouse analysis

You answer questions from a read-only warehouse through the `semantic-warehouse-mcp` tools. The goal is a
**correct** number with its definition stated, not just a plausible one. Most wrong answers come from three
mistakes: inventing a metric definition, filtering on a name that doesn't exactly match, and joining or
summing at the wrong grain. This workflow is built to avoid all three.

## 1. Orient (once per conversation)

- If `list_metrics` exists, call it first. The semantic layer holds the agreed definitions, and its
  descriptions carry the caveats (e.g. "only available from 2022-23", "excludes managers"). Read them.
- Call `list_tables` only when you need something the metrics don't cover. Prefer the curated
  schema (often `marts`); the server may refuse others.

## 2. Map the question to metrics and dimensions

1. Pick metrics by **definition**, not by name. "Best value" might be `points_per_million`; "most
   productive" might be a per-90 metric rather than a total. If two readings are plausible, pick the
   more standard one and say which you used.
2. Call `list_dimensions` with exactly those metrics. Use only names it returns.
   - `entity__dimension` follows a join (`player__player_name`), so you never write the join yourself.
   - `metric_time__month` / `__year` etc. buckets time; the bare entity name (`player`) groups by its
     stable key.
3. If a needed dimension isn't listed for a metric, the semantic layer can't answer that combination.
   Don't force it: split the question, or fall back to `run_query` (section 5).

## 3. Resolve exact values before filtering

Filters match exact strings. "Salah" will not match "Mohamed Salah", and "Manchester United" will not
match "Man Utd".

- Look the value up first with an `ilike` filter:
  `query_metrics(metrics=[<any metric>], group_by=["player__player_name"], where=[{"field": "player__player_name", "op": "ilike", "value": "%salah%"}])`
- If several entities match (two players named "Palacios"), group by the **entity key** as well
  (`group_by: ["player", "player__player_name"]`) and either ask the user or answer for each one.
- Never assume a display name is unique or stable over time. Group by the entity, label with the name.

## 4. Query, then sanity-check

Call `query_metrics`. Before answering, check:

- **`truncated`**: if true, you only saw part of the result. Add `order_by` + `limit`, or aggregate further.
- **Rate metrics need a minimum sample.** Ranking by a ratio (per 90, per appearance, conversion rate)
  surfaces tiny samples first. Include the volume metric and filter it with `having`, e.g.
  `having: [{"field": "minutes_played", "op": ">=", "value": 900}]`, and say what threshold you used.
- **Ties.** If ranks tie at the cut-off, mention it instead of silently dropping one.
- **NULL means "not recorded"**, not zero. If a metric is NULL for some periods, say it's unavailable
  there rather than reporting 0.
- **Plausibility.** Compare against something you know (a season has a fixed number of matches; totals
  should exceed any part). If a number looks off, read the returned `sql` and check the filters.

## 5. When the metrics don't cover it: `run_query`

Write SQL only for questions no metric answers (lists of raw rows, unusual definitions, metadata).

- `describe_table` first; read column comments. They often state the grain and the stable keys.
- **Respect the grain.** Know what one row is (player x fixture, order line, ...). Aggregate to the grain
  of the question; "per gameweek" or "per order" is often a SUM over several rows.
- **Join on keys, never on names**, and check for fan-out: `count(*)` before and after a join should
  match when joining to a dimension.
- One statement per call, aggregate in SQL, and quote identifiers that are keywords (`"minutes"`).
- If you computed something a metric also defines, use the metric instead; your SQL may not
  encode the same caveats.

## 6. Guardrail refusals

`Refused (...)` errors are deliberate (read-only, schema allow-list, timeouts, single statement). Do not
try to work around them; rephrase within the rules or tell the user what's out of scope.
`Invalid metric query: ... Did you mean ...?` is a fixable typo: use the suggested name.

## 7. Answer

- Lead with the answer (number, ranking, trend), then **how it was defined**: the metric names, the
  filters, the time range, any minimum sample.
- State caveats the metric descriptions mention when they apply (missing early data, excluded rows).
- Offer the SQL (`query_metrics` returns it) if the user may want to reuse or audit it.
- Keep rounding sensible (1-2 decimals for rates) and never present a number you didn't retrieve.

See [references/query-patterns.md](references/query-patterns.md) for ready-made `query_metrics` calls
(top-N with a minimum sample, time series, segment comparison, share of total, period over period).
