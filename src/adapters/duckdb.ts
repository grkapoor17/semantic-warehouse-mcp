import { DuckDBConnection, DuckDBInstance, StatementType } from "@duckdb/node-api";
import {
  GuardError,
  type ColumnInfo,
  type QueryLimits,
  type QueryResult,
  type TableInfo,
  type WarehouseAdapter,
} from "./types.js";

/**
 * Engine-level sandbox. With these settings DuckDB itself refuses writes, any file or network
 * access (read_csv('/etc/passwd'), COPY ... TO, ATTACH, httpfs), extension installs, and any
 * attempt to SET these options back. The statement check in `query` is a second layer on top.
 */
const SANDBOX = {
  access_mode: "READ_ONLY",
  enable_external_access: "false",
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
  lock_configuration: "true",
} as const;

const ALLOWED: ReadonlySet<StatementType> = new Set([StatementType.SELECT, StatementType.EXPLAIN]);

const HIDDEN_SCHEMAS = ["information_schema", "pg_catalog"];

export interface DuckDBOptions {
  threads?: number;
  memoryLimit?: string;
  /**
   * Only these schemas are listed AND queryable (e.g. ["marts"]). Enforced on every query by walking
   * DuckDB's own parse tree for table references, not just hidden from list_tables.
   */
  allowedSchemas?: string[];
}

export class DuckDBAdapter implements WarehouseAdapter {
  readonly dialect = "duckdb";

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    private readonly allowedSchemas: Set<string> | null,
  ) {}

  /** Opens an existing DuckDB database file read-only inside the sandbox. */
  static async open(path: string, options: DuckDBOptions = {}): Promise<DuckDBAdapter> {
    const config: Record<string, string> = { ...SANDBOX };
    if (options.threads) config.threads = String(options.threads);
    if (options.memoryLimit) config.memory_limit = options.memoryLimit;
    const instance = await DuckDBInstance.create(path, config);
    const conn = await instance.connect();
    const allowed = options.allowedSchemas?.length ? new Set(options.allowedSchemas.map((s) => s.toLowerCase())) : null;
    return new DuckDBAdapter(instance, conn, allowed);
  }

  async listTables(): Promise<TableInfo[]> {
    const reader = await this.conn.runAndReadAll(
      `select schema_name, table_name, 'table' as kind, estimated_size, comment
         from duckdb_tables() where not internal and database_name = current_database()
       union all
       select schema_name, view_name, 'view', null, comment
         from duckdb_views() where not internal and database_name = current_database()
       order by 1, 2`,
    );
    return reader
      .getRowObjectsJS()
      .filter((r) => !HIDDEN_SCHEMAS.includes(String(r.schema_name)))
      .filter((r) => !this.allowedSchemas || this.allowedSchemas.has(String(r.schema_name).toLowerCase()))
      .map((r) => toTableInfo(r));
  }

  async describeTable(name: string): Promise<{ table: TableInfo; columns: ColumnInfo[] }> {
    const tables = await this.listTables();
    const wanted = name.trim().toLowerCase();
    const table =
      tables.find((t) => t.name.toLowerCase() === wanted) ??
      // Allow the bare table name when it is unambiguous.
      singleOrUndefined(tables.filter((t) => t.table.toLowerCase() === wanted));
    if (!table) {
      throw new GuardError("table_not_found", `No table or view named "${name}". Call list_tables to see what exists.`);
    }
    const reader = await this.conn.runAndReadAll(
      `select column_name, data_type, is_nullable, comment
         from duckdb_columns()
        where database_name = current_database() and schema_name = $schema and table_name = $table
        order by column_index`,
      { schema: table.schema, table: table.table },
    );
    const columns = reader.getRowObjectsJS().map((r) => ({
      name: String(r.column_name),
      type: String(r.data_type),
      nullable: Boolean(r.is_nullable),
      comment: (r.comment as string | null) ?? null,
    }));
    return { table, columns };
  }

  async query(sql: string, limits: QueryLimits): Promise<QueryResult> {
    if (!sql.trim()) throw new GuardError("empty_query", "The query is empty.");

    // Use DuckDB's own parser rather than regexes to decide what the statement is.
    let extracted;
    try {
      extracted = await this.conn.extractStatements(sql);
    } catch (err) {
      // Input with zero statements (only comments or `;`) makes the native binding throw this bare
      // message; real syntax errors come back as "Parser Error: ..." and are passed through.
      if (err instanceof Error && err.message === "Error in native callback") {
        throw new GuardError("empty_query", "The query has no SQL statement in it.");
      }
      throw err;
    }
    if (extracted.count === 0) throw new GuardError("empty_query", "The query is empty.");
    if (extracted.count > 1) {
      throw new GuardError("multiple_statements", `Send one statement at a time (got ${extracted.count}).`);
    }
    const prepared = await extracted.prepare(0);
    if (!ALLOWED.has(prepared.statementType)) {
      throw new GuardError(
        "statement_not_allowed",
        `Only SELECT (including WITH ... SELECT) and EXPLAIN are allowed; got ${StatementType[prepared.statementType]}.`,
      );
    }
    if (this.allowedSchemas) await this.checkSchemas(sql, prepared.statementType);

    const started = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.conn.interrupt();
    }, limits.timeoutMs);
    try {
      // Stream so a huge result is never fully materialised: read one row past the cap to detect truncation.
      const reader = await prepared.streamAndReadUntil(limits.maxRows + 1);
      const all = reader.getRowObjectsJson();
      const names = reader.columnNames();
      const types = reader.columnTypes().map(String);
      const numeric = names.filter((_, i) => WIDE_NUMERIC.test(types[i]!));
      const rows = all.slice(0, limits.maxRows).map((row) => {
        const out = row as Record<string, unknown>;
        for (const n of numeric) out[n] = toNumber(out[n]);
        return out;
      });
      return {
        columns: names.map((n, i) => ({ name: n, type: types[i]! })),
        rows,
        truncated: all.length > limits.maxRows,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (timedOut) {
        throw new GuardError("timeout", `Query stopped after ${limits.timeoutMs} ms. Narrow it or aggregate first.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Refuse queries that read a table outside the allowed schemas. Uses DuckDB's own parser
   * (json_serialize_sql) to find every base-table reference, including inside CTEs, subqueries
   * and set operations. CTE names are not tables; unqualified names resolve to schema "main".
   * Fails closed: anything we can't parse is refused.
   */
  private async checkSchemas(sql: string, type: StatementType): Promise<void> {
    let inner = sql;
    if (type === StatementType.EXPLAIN) {
      const m = /^\s*explain\s+(analyze\s+)?/i.exec(sql);
      if (!m) throw new GuardError("schema_not_allowed", "Could not check the tables this EXPLAIN reads; run the query without EXPLAIN.");
      inner = sql.slice(m[0].length);
    }
    const reader = await this.conn.runAndReadAll("select json_serialize_sql($1::varchar) as ast", [inner]);
    const ast = JSON.parse(String(reader.getRowObjectsJS()[0]?.ast)) as { error?: boolean; statements?: unknown };
    if (ast.error || !ast.statements) {
      throw new GuardError("schema_not_allowed", "Could not check which tables this query reads, so it was refused.");
    }
    const { tables, ctes } = collectRefs(ast.statements);
    const allowed = [...this.allowedSchemas!].join(", ");
    for (const t of tables) {
      if (!t.schema && ctes.has(t.table.toLowerCase())) continue;
      const schema = (t.schema || "main").toLowerCase();
      if (!this.allowedSchemas!.has(schema)) {
        throw new GuardError(
          "schema_not_allowed",
          `"${t.schema ? `${t.schema}.` : ""}${t.table}" is outside the allowed schemas (${allowed}). Call list_tables to see what you can query.`,
        );
      }
    }
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

/** Integer and decimal types that DuckDB's JSON conversion returns as strings. */
const WIDE_NUMERIC = /^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|DECIMAL\(\d+,\s*\d+\))$/;

/** Return a JS number when it is exact (or, for decimals, a normal double); otherwise keep the string. */
function toNumber(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (/^-?\d+$/.test(v)) return Number.isSafeInteger(n) ? n : v;
  return Math.abs(n) < 2 ** 53 ? n : v;
}

function collectRefs(node: unknown, acc = { tables: [] as { schema: string; table: string }[], ctes: new Set<string>() }) {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, acc);
  } else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.type === "BASE_TABLE" && typeof o.table_name === "string") {
      acc.tables.push({ schema: String(o.schema_name ?? ""), table: o.table_name });
    }
    const cteMap = (o.cte_map as { map?: { key: string }[] } | undefined)?.map;
    if (Array.isArray(cteMap)) for (const e of cteMap) acc.ctes.add(String(e.key).toLowerCase());
    for (const v of Object.values(o)) collectRefs(v, acc);
  }
  return acc;
}

function toTableInfo(r: Record<string, unknown>): TableInfo {
  const schema = String(r.schema_name);
  const table = String(r.table_name);
  return {
    name: `${schema}.${table}`,
    schema,
    table,
    kind: r.kind === "view" ? "view" : "table",
    estimatedRows: r.estimated_size == null ? null : Number(r.estimated_size),
    comment: (r.comment as string | null) || null,
  };
}

function singleOrUndefined<T>(xs: T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}
