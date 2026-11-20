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

export class DuckDBAdapter implements WarehouseAdapter {
  readonly dialect = "duckdb";

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  /** Opens an existing DuckDB database file read-only inside the sandbox. */
  static async open(path: string, options: { threads?: number; memoryLimit?: string } = {}): Promise<DuckDBAdapter> {
    const config: Record<string, string> = { ...SANDBOX };
    if (options.threads) config.threads = String(options.threads);
    if (options.memoryLimit) config.memory_limit = options.memoryLimit;
    const instance = await DuckDBInstance.create(path, config);
    const conn = await instance.connect();
    return new DuckDBAdapter(instance, conn);
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
      const types = reader.columnTypes();
      return {
        columns: names.map((n, i) => ({ name: n, type: String(types[i]) })),
        rows: all.slice(0, limits.maxRows) as Record<string, unknown>[],
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

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }
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
