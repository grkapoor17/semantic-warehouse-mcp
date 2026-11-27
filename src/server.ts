import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GuardError, type QueryLimits, type WarehouseAdapter } from "./adapters/types.js";
import { SemanticCatalog, SemanticError } from "./semantic/catalog.js";
import { compileMetricQuery, FILTER_OPS } from "./semantic/compile.js";
import type { SemanticManifest } from "./semantic/manifest.js";

export interface ServerOptions {
  adapter: WarehouseAdapter;
  /** dbt's target/semantic_manifest.json; enables list_metrics / list_dimensions / query_metrics. */
  semanticManifest?: SemanticManifest;
  limits?: Partial<QueryLimits>;
  name?: string;
  version?: string;
}

export const DEFAULT_LIMITS: QueryLimits = { maxRows: 200, timeoutMs: 15_000 };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SEMANTIC_INSTRUCTIONS =
  "This warehouse has a semantic layer: agreed definitions of metrics and how tables join. " +
  "For any question a metric covers, use list_metrics -> list_dimensions -> query_metrics instead of writing SQL; " +
  "the definitions encode data quirks raw SQL tends to get wrong. Use run_query for anything the metrics don't cover, " +
  "and to look up exact dimension values (e.g. a player's full name) before filtering on them.";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const filterSchema = z.object({
  field: z.string().describe("A dimension name from list_dimensions (for where) or an output column (for having)"),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar)]).optional().describe("Omit for 'is null' / 'is not null'; a list for 'in' / 'not in'"),
});

export function createServer({ adapter, semanticManifest, limits, name = "semantic-warehouse-mcp", version = "0.1.0" }: ServerOptions) {
  const lim: QueryLimits = { ...DEFAULT_LIMITS, ...limits };
  const catalog = semanticManifest ? new SemanticCatalog(semanticManifest) : null;
  const server = new McpServer({ name, version }, catalog ? { instructions: SEMANTIC_INSTRUCTIONS } : undefined);

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

  if (catalog) {
    server.registerTool(
      "list_metrics",
      {
        title: "List metrics",
        description:
          "List the metrics defined in the semantic layer, with their definitions. `notes` describe the table each " +
          "metric is computed from, including caveats (rows to exclude, grain, missing data); read them before querying.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => respond(async () => ({ metrics: catalog.listMetrics() })),
    );

    server.registerTool(
      "list_dimensions",
      {
        title: "List dimensions",
        description:
          "List the dimensions you can group by or filter on for ALL of the given metrics. " +
          "Names look like entity__dimension (e.g. player__player_name). Time dimensions accept a grain suffix " +
          "(e.g. metric_time__month); entity names alone group by the entity's key.",
        inputSchema: { metrics: z.array(z.string()).min(1).describe("Metric names from list_metrics") },
        annotations: READ_ONLY,
      },
      async ({ metrics }) => respond(async () => ({ metrics, dimensions: catalog.commonDimensions(metrics) })),
    );

    server.registerTool(
      "query_metrics",
      {
        title: "Query metrics",
        description:
          "Compute semantic-layer metrics, grouped and filtered by dimensions. The server compiles the definitions to SQL " +
          `(returned as "sql") and runs it read-only; at most ${lim.maxRows} rows come back.`,
        inputSchema: {
          metrics: z.array(z.string()).min(1).describe("Metric names from list_metrics"),
          group_by: z.array(z.string()).optional().describe("Dimension names from list_dimensions"),
          where: z.array(filterSchema).optional().describe("Dimension filters, applied before aggregating (ANDed)"),
          having: z.array(filterSchema).optional().describe("Filters on output metrics/group-bys, applied after aggregating (ANDed)"),
          order_by: z.array(z.object({ field: z.string(), descending: z.boolean().optional() })).optional(),
          limit: z.number().int().positive().optional(),
        },
        annotations: READ_ONLY,
      },
      async (q) =>
        respond(async () => {
          const sql = compileMetricQuery(catalog, q);
          return { ...(await adapter.query(sql, lim)), sql };
        }),
    );
  }

  return server;
}

/** Wrap a tool body: success -> JSON text; refusals and errors -> isError with a message the model can act on. */
async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof GuardError
        ? `Refused (${err.code}): ${err.message}`
        : err instanceof SemanticError
          ? `Invalid metric query: ${err.message}`
          : `SQL error: ${err instanceof Error ? err.message : String(err)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
