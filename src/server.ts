import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GuardError, type QueryLimits, type WarehouseAdapter } from "./adapters/types.js";

export interface ServerOptions {
  adapter: WarehouseAdapter;
  limits?: Partial<QueryLimits>;
  name?: string;
  version?: string;
}

export const DEFAULT_LIMITS: QueryLimits = { maxRows: 200, timeoutMs: 15_000 };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createServer({ adapter, limits, name = "semantic-warehouse-mcp", version = "0.1.0" }: ServerOptions) {
  const lim: QueryLimits = { ...DEFAULT_LIMITS, ...limits };
  const server = new McpServer({ name, version });

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List every table and view you can query, with approximate row counts and descriptions.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => respond(async () => ({ dialect: adapter.dialect, tables: await adapter.listTables() })),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: "Show the columns (name, type, nullability, description) of one table or view.",
      inputSchema: { table: z.string().min(1).describe("Table name as returned by list_tables, e.g. main.players") },
      annotations: READ_ONLY,
    },
    async ({ table }) => respond(() => adapter.describeTable(table)),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run read-only SQL",
      description:
        `Run ONE read-only SQL statement (SELECT / WITH ... SELECT / EXPLAIN) in the ${adapter.dialect} dialect. ` +
        `At most ${lim.maxRows} rows come back (check "truncated"); queries over ${lim.timeoutMs} ms are stopped. ` +
        "Aggregate in SQL instead of pulling raw rows.",
      inputSchema: { sql: z.string().min(1).describe("A single SQL statement") },
      annotations: READ_ONLY,
    },
    async ({ sql }) => respond(() => adapter.query(sql, lim)),
  );

  return server;
}

/** Wrap a tool body: success → JSON text; guard refusals and SQL errors → isError with a message the model can act on. */
async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof GuardError
        ? `Refused (${err.code}): ${err.message}`
        : `SQL error: ${err instanceof Error ? err.message : String(err)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
