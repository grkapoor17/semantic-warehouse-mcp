#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DuckDBAdapter } from "./adapters/duckdb.js";
import { createServer, DEFAULT_LIMITS } from "./server.js";

const USAGE = `Usage: semantic-warehouse-mcp --duckdb <file.duckdb> [--max-rows N] [--timeout-ms N]

Serves a read-only MCP server over stdio.`;

async function main() {
  const { values } = parseArgs({
    options: {
      duckdb: { type: "string" },
      "max-rows": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.duckdb) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const adapter = await DuckDBAdapter.open(values.duckdb);
  const server = createServer({
    adapter,
    limits: {
      maxRows: positiveInt(values["max-rows"], DEFAULT_LIMITS.maxRows),
      timeoutMs: positiveInt(values["timeout-ms"], DEFAULT_LIMITS.timeoutMs),
    },
  });

  const shutdown = async () => {
    await server.close();
    await adapter.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(`semantic-warehouse-mcp: serving ${values.duckdb} (read-only)`);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Expected a positive integer, got "${raw}"`);
  return n;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
