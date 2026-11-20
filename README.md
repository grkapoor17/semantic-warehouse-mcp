# semantic-warehouse-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents **guarded, read-only SQL access** to a data warehouse, plus **dbt semantic-layer metrics** compiled straight from your project's `semantic_manifest.json`, with no dbt Cloud and no MetricFlow server required.

> Status: early. DuckDB + semantic layer work today (results match MetricFlow on 12/12 reference queries). Postgres, BigQuery, and a text-to-SQL eval are in progress.

## Why

Pointing an agent at a warehouse raises two problems:

1. **Safety.** The agent must not be able to write, read local files, reach the network, or run a query that never finishes.
2. **Correctness.** Raw schemas don't tell an agent what "points per game" or "a player across seasons" means. A semantic layer does.

This project tackles both and measures the second: an eval of text-to-SQL accuracy **with vs. without** semantic-layer context (results to come).

## Guardrails (DuckDB)

There are two layers, and each would stop the attacks below on its own:

| Layer | What it does |
|---|---|
| Engine sandbox | Opens the file `READ_ONLY` with `enable_external_access=false`, extension autoload/autoinstall off, and `lock_configuration=true`. DuckDB itself refuses writes, `read_csv('/etc/passwd')`, `COPY … TO`, `ATTACH`, `httpfs`, and attempts to `SET` any of this back. |
| Statement check | Uses DuckDB's own parser (not regexes): exactly **one** statement, and it must be `SELECT` / `WITH … SELECT` / `EXPLAIN`. Stops `select 1; drop table t`. |
| Schema allow-list | `--schemas marts` lists *and enforces* only those schemas: every query's table references are read from DuckDB's parse tree (including CTEs, subqueries, UNIONs, LATERAL, EXPLAIN), and anything outside is refused. Not just hidden. |
| Limits | Results stream with a row cap (`truncated` flag); queries past the time budget are interrupted. |

Every refusal goes back to the model as a readable tool error (`Refused (multiple_statements): …`), so it can fix its query and try again.

## Tools

| Tool | Description |
|---|---|
| `list_tables` | Tables and views, with approximate row counts and comments |
| `describe_table` | Columns, types, nullability, comments |
| `run_query` | One read-only SQL statement, row-capped and time-limited |
| `list_metrics` | Semantic-layer metrics with their definitions and caveats *(with `--semantic-manifest`)* |
| `list_dimensions` | Dimensions usable with *all* of the given metrics, e.g. `player__player_name`, `metric_time__month` |
| `query_metrics` | Metrics + group-bys + structured filters, compiled to SQL and run through the same guards. Returns the SQL it ran. |

## Semantic layer

Point the server at the `target/semantic_manifest.json` that `dbt parse` writes. The server compiles metric
queries itself, following MetricFlow's semantics:

1. For each table involved: project its columns, `LEFT JOIN` dimension tables through entity keys, filter, aggregate.
2. If metrics come from several tables, `FULL OUTER JOIN` them on the group-by columns (e.g. `metric_time`).
3. Compute ratio metrics (`cast(num as double) / nullif(den, 0)`) and derived metrics on the aggregated values.
4. Apply `having`, `order_by`, `limit`.

Filters are structured (`{field, op, value}`), and values are rendered as escaped literals, never spliced in as SQL.
Results are checked against MetricFlow's own output on the example warehouse (`test/fpl-parity.test.ts`).

**Supported:** simple, ratio and derived metrics (nested, with aliases); `sum`, `count`, `count_distinct`,
`average`, `min`, `max`, `median`, `sum_boolean`; one-hop entity joins; time grains day to year; group by entity keys.
**Not yet:** cumulative and conversion metrics, metric-level filters, offsets, percentiles, non-additive dimensions,
multi-hop joins. These are refused with a clear message instead of being guessed at.

**Known DuckDB quirk:** if the database file has the same name as one of its schemas (`shop.duckdb` with schema
`shop`), DuckDB treats `shop.table` as ambiguous. Rename the file.

## Use with Claude Code

```bash
npm install && npm run build
claude mcp add warehouse -- node /path/to/semantic-warehouse-mcp/dist/cli.js \
  --duckdb /path/to/warehouse.duckdb \
  --semantic-manifest /path/to/dbt/target/semantic_manifest.json \
  --schemas marts
```

Options: `--semantic-manifest`, `--schemas` (comma-separated), `--max-rows` (default 200), `--timeout-ms` (default 15000).

Try it on real data: [`examples/fpl`](examples/fpl) builds an 11-season Fantasy Premier League warehouse with a
26-metric semantic layer in one command.

## Development

```bash
npm test        # vitest: guardrail attack suite, compiler unit tests, MCP surface tests
                # + MetricFlow parity tests when examples/fpl/fpl.duckdb has been built
npm run build
```

## License

MIT
