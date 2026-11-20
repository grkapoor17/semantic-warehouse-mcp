/** A table or view the agent is allowed to see. */
export interface TableInfo {
  /** Fully qualified name the agent should use in SQL, e.g. `main.fct_player_gameweeks`. */
  name: string;
  schema: string;
  table: string;
  kind: "table" | "view";
  /** Approximate row count when the engine knows it cheaply; otherwise null. */
  estimatedRows: number | null;
  comment: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  comment: string | null;
}

export interface QueryLimits {
  /** Maximum rows returned to the agent. Extra rows are dropped and `truncated` is set. */
  maxRows: number;
  /** Wall-clock budget; the query is interrupted when it runs longer. */
  timeoutMs: number;
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  /** True when the query produced more than `maxRows` rows. */
  truncated: boolean;
  elapsedMs: number;
}

/** One warehouse engine. Every implementation must be read-only at the engine level, not just by convention. */
export interface WarehouseAdapter {
  readonly dialect: string;
  listTables(): Promise<TableInfo[]>;
  describeTable(name: string): Promise<{ table: TableInfo; columns: ColumnInfo[] }>;
  query(sql: string, limits: QueryLimits): Promise<QueryResult>;
  close(): Promise<void>;
}

export type GuardCode =
  | "empty_query"
  | "multiple_statements"
  | "statement_not_allowed"
  | "timeout"
  | "table_not_found"
  | "schema_not_allowed";

/** A query the server refused (or stopped) on purpose, as opposed to a SQL error from the engine. */
export class GuardError extends Error {
  constructor(
    readonly code: GuardCode,
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}
