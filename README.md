# semantic-warehouse-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents **guarded, read-only SQL access** to a data warehouse, plus (coming next) **dbt semantic-layer metrics** read straight from your project's YAML, with no dbt Cloud required.

> Status: early. DuckDB works today. Semantic layer, Postgres, BigQuery, and a text-to-SQL eval are in progress.

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
| Limits | Results stream with a row cap (`truncated` flag); queries past the time budget are interrupted. |

Every refusal goes back to the model as a readable tool error (`Refused (multiple_statements): …`), so it can fix its query and try again.

## Tools

| Tool | Description |
|---|---|
| `list_tables` | Tables and views, with approximate row counts and comments |
| `describe_table` | Columns, types, nullability, comments |
| `run_query` | One read-only SQL statement, row-capped and time-limited |

## Use with Claude Code

```bash
npm install && npm run build
claude mcp add warehouse -- node /path/to/semantic-warehouse-mcp/dist/cli.js --duckdb /path/to/warehouse.duckdb
```

Options: `--max-rows` (default 200) and `--timeout-ms` (default 15000).

## Development

```bash
npm test        # vitest: guardrail attack suite + MCP surface tests
npm run build
```

## License

MIT
