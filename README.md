# semantic-warehouse-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents **guarded, read-only SQL access** to a data
warehouse, plus **dbt semantic-layer metrics** compiled straight from your project's `semantic_manifest.json`, with no
dbt Cloud and no MetricFlow server required.

- **Safe by construction.** The database engine itself refuses writes, file and network access, and config changes;
  on top of that, DuckDB's parser allows one `SELECT` per call, and a schema allow-list is checked on every query.
- **Correct by definition.** Agents ask for `total_points` by `player__player_name` and get your team's definition
  of the metric, joins and caveats included, instead of guessing from column names. The compiler matches dbt's own
  MetricFlow on 12/12 reference queries.
- **Measured.** A 450-run eval across Claude, GPT and Gemini (below) shows what the semantic layer and the bundled
  Agent Skill actually change.

> Status: early (0.1). DuckDB today; Postgres and BigQuery are planned.

## Quick start

```bash
# Claude Code
claude mcp add warehouse -- npx -y semantic-warehouse-mcp \
  --duckdb /path/to/warehouse.duckdb \
  --semantic-manifest /path/to/dbt/target/semantic_manifest.json \
  --schemas marts
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "warehouse": {
      "command": "npx",
      "args": ["-y", "semantic-warehouse-mcp", "--duckdb", "/path/to/warehouse.duckdb",
               "--semantic-manifest", "/path/to/dbt/target/semantic_manifest.json", "--schemas", "marts"]
    }
  }
}
```

| Option | Default | |
|---|---|---|
| `--duckdb` | (required) | DuckDB file; always opened read-only |
| `--semantic-manifest` | none | dbt's `target/semantic_manifest.json` (from `dbt parse`); adds the three metric tools |
| `--schemas` | all | Comma-separated schemas the agent may list **and** query |
| `--max-rows` | 200 | Rows returned per query (`truncated: true` when cut) |
| `--timeout-ms` | 15000 | Queries running longer are interrupted |

**No warehouse handy?** [`examples/fpl`](examples/fpl) builds an 11-season Fantasy Premier League warehouse (258k
rows) with a 26-metric semantic layer in one command (`./build.sh`).

## Tools

| Tool | Description |
|---|---|
| `list_tables` | Tables and views, with approximate row counts and descriptions |
| `describe_table` | Columns, types, nullability, descriptions |
| `run_query` | One read-only SQL statement, row-capped and time-limited |
| `list_metrics` | Metrics with their definitions, plus `notes` from the table each comes from (caveats, grain, exclusions) |
| `list_dimensions` | Dimensions usable with *all* of the given metrics, e.g. `player__player_name`, `metric_time__month` |
| `query_metrics` | Metrics + group-bys + structured filters, compiled to SQL and run through the same guards. Returns the SQL it ran. |

The last three appear only with `--semantic-manifest`. Descriptions come from your dbt YAML: turn on
[`persist_docs`](https://docs.getdbt.com/reference/resource-configs/persist_docs) so they reach the warehouse.

## Does it help? The eval

50 questions about the FPL warehouse, each built around a real data trap (a player whose ID and display name change
every season, two different people named Danny Ward, team goals that include opponents' own goals, managers listed as
players, 1-minute substitutes topping "points per 90"...). Gold answers come from hand-written SQL, never from this
server, and 14 were cross-checked against dbt's MetricFlow. Three setups, three models, 450 runs, $8.59.

| Accuracy (47 questions) | A: SQL tools only | B: + semantic layer | C: + semantic + skill |
|---|---|---|---|
| Claude Haiku 5.5 | 89.4% | 93.6% | **95.7%** |
| GPT-6.1 Terra | 95.7% | 95.7% | **97.9%** |
| Gemini 3.8 Flash | 97.9% | 97.9% | 97.9% |
| **All** | **94.3%** | **95.7%** | **97.2%** |
| Tool calls per question | 6.2 | 5.6 | **4.6** |

What it showed:

- **Clean dbt models do most of the work.** Plain SQL on well-named tables already scored 94%.
- **The semantic layer and skill help most where the model is weakest:** Haiku went 89% → 96%, and the skill
  consistently stopped it from adding two different people with the same name together.
- **They cut tool calls by 25%,** though not cost: more context per request.
- **The eval found gaps in this server.** Table-level caveats weren't reaching agents. After fixing that
  ([v2](eval/results/v2.md)), a question about managers listed as players went from 1/9 to 7/9 correct.

One run per question, so treat small gaps as directional. Full write-ups: [v1](eval/results/v1.md),
[v2](eval/results/v2.md); method and questions in [`eval/`](eval).

## Guardrails (DuckDB)

| Layer | What it does |
|---|---|
| Engine sandbox | Opens the file `READ_ONLY` with `enable_external_access=false`, extension autoload/autoinstall off, and `lock_configuration=true`. DuckDB itself refuses writes, `read_csv('/etc/passwd')`, `COPY … TO`, `ATTACH`, `httpfs`, and attempts to `SET` any of this back. |
| Statement check | Uses DuckDB's own parser (not regexes): exactly **one** statement, and it must be `SELECT` / `WITH … SELECT` / `EXPLAIN`. Stops `select 1; drop table t`. |
| Schema allow-list | `--schemas marts` lists *and enforces* only those schemas: every query's table references are read from DuckDB's parse tree (including CTEs, subqueries, UNIONs, LATERAL, EXPLAIN), and anything outside is refused. Not just hidden. |
| Limits | Results stream with a row cap (`truncated` flag); queries past the time budget are interrupted. |

Every refusal goes back to the model as a readable tool error (`Refused (multiple_statements): …`), so it can fix
its query and try again.

## Semantic layer

The server compiles metric queries itself, following MetricFlow's semantics:

1. For each table involved: project its columns, `LEFT JOIN` dimension tables through entity keys, filter, aggregate.
2. If metrics come from several tables, `FULL OUTER JOIN` them on the group-by columns (e.g. `metric_time`).
3. Compute ratio metrics (`cast(num as double) / nullif(den, 0)`) and derived metrics on the aggregated values.
4. Apply `having`, `order_by`, `limit`.

Filters are structured (`{field, op, value}`), and values are rendered as escaped literals, never spliced in as SQL.

**Supported:** simple, ratio and derived metrics (nested, with aliases); `sum`, `count`, `count_distinct`,
`average`, `min`, `max`, `median`, `sum_boolean`; one-hop entity joins; time grains day to year; group by entity keys.
**Not yet:** cumulative and conversion metrics, metric-level filters, offsets, percentiles, non-additive dimensions,
multi-hop joins. These are refused with a clear message instead of being guessed at.

**Known DuckDB quirk:** if the database file has the same name as one of its schemas (`shop.duckdb` with schema
`shop`), DuckDB treats `shop.table` as ambiguous. Rename the file.

## Agent Skill

[`skills/warehouse-analysis`](skills/warehouse-analysis/SKILL.md) teaches Claude a workflow on top of these tools:
use metrics before hand-written SQL, look up exact names before filtering, require a minimum sample when ranking
by a rate, respect the grain, and state the definitions used in the answer. Its
[query patterns](skills/warehouse-analysis/references/query-patterns.md) are tested against the example warehouse.

- **Claude Code:** copy the folder to `~/.claude/skills/` (all projects) or `.claude/skills/` (one project).
- **Claude apps:** zip the `warehouse-analysis` folder and upload it under Settings → Capabilities → Skills.

## Development

```bash
npm install && npm run build
npm test        # guardrail attack suite, compiler unit tests, MCP surface tests, eval harness (fake clients)
                # + MetricFlow parity tests when examples/fpl/data/fpl.duckdb has been built
```

## License

MIT
