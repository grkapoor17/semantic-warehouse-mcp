import { quoteIdent, SemanticCatalog, SemanticError, suggest, type MeasureGroup, type ResolvedDimension } from "./catalog.js";
import type { Measure, MetricInput, SemanticModel } from "./manifest.js";

export type Scalar = string | number | boolean;
export const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not in", "like", "ilike", "is null", "is not null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  field: string;
  op: FilterOp;
  value?: Scalar | Scalar[];
}

export interface MetricQuery {
  metrics: string[];
  group_by?: string[];
  /** Row filters on dimensions, applied before aggregating. */
  where?: Filter[];
  /** Filters on the output (metrics or group-by columns), applied after aggregating. */
  having?: Filter[];
  order_by?: { field: string; descending?: boolean }[];
  limit?: number;
}

/**
 * Compile a metric query to one SELECT, following MetricFlow's semantics:
 *   1. per (table, time dimension) group: project the table's own columns, LEFT JOIN dimension
 *      tables through entity keys, apply `where`, aggregate measures by the group-by dimensions;
 *   2. FULL OUTER JOIN the groups on the group-by columns (when metrics span several tables);
 *   3. compute ratio and derived metrics from the aggregated measures;
 *   4. apply `having`, `order_by`, `limit`.
 * Values in filters are rendered as escaped literals, never spliced as raw SQL.
 */
export function compileMetricQuery(catalog: SemanticCatalog, q: MetricQuery): string {
  const metrics = unique(q.metrics);
  if (metrics.length === 0) throw new SemanticError("Ask for at least one metric.");
  const groupBy = unique(q.group_by ?? []);
  const where = q.where ?? [];

  const groups = catalog.measureGroups(metrics);
  const ctes = groups.map((g, i) => `g${i} as (\n${indent(groupSql(catalog, g, groupBy, where, metrics))}\n)`);

  const using = groupBy.map(quoteIdent).join(", ");
  const joined = groups
    .map((_, i) => `g${i}`)
    .reduce((acc, g) => (groupBy.length ? `${acc}\n  full outer join ${g} using (${using})` : `${acc}\n  cross join ${g}`));

  const outputs = new Set([...groupBy, ...metrics]);
  const select = [
    ...groupBy.map(quoteIdent),
    ...metrics.map((m) => `${metricExpr(catalog, m)} as ${quoteIdent(m)}`),
  ];
  let sql = `with ${ctes.join(",\n")}\nselect\n  ${select.join(",\n  ")}\nfrom ${joined}`;

  if (q.having?.length) {
    const conds = q.having.map((f) => {
      if (!outputs.has(f.field)) {
        throw new SemanticError(`having can only filter on the query's metrics or group_by fields; "${f.field}" is neither.`);
      }
      return filterSql(quoteIdent(f.field), f);
    });
    sql = `select * from (\n${indent(sql)}\n) as q\nwhere ${conds.join("\n  and ")}`;
  }

  if (q.order_by?.length) {
    const parts = q.order_by.map((o) => {
      if (!outputs.has(o.field)) {
        throw new SemanticError(`order_by "${o.field}" must be one of the query's metrics or group_by fields.`);
      }
      return `${quoteIdent(o.field)} ${o.descending ? "desc" : "asc"} nulls last`;
    });
    sql += `\norder by ${parts.join(", ")}`;
  }
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1) throw new SemanticError("limit must be a positive integer.");
    sql += `\nlimit ${q.limit}`;
  }
  return sql;
}

/** One measure group: its table, joined dimension tables, filters, and aggregated measures. */
function groupSql(catalog: SemanticCatalog, g: MeasureGroup, groupBy: string[], where: { field: string }[], metrics: string[]): string {
  const available = catalog.dimensionsFor(g);
  const resolve = (field: string, role: string): ResolvedDimension => {
    const r = available.get(field);
    if (r) return r;
    const usable = metrics.filter((m) => catalog.measureGroups([m]).some((x) => x.key === g.key));
    throw new SemanticError(
      `${role} "${field}" is not available for ${usable.map((m) => `"${m}"`).join(", ")}.` +
        `${suggest(field, [...available.keys()])} Call list_dimensions with these metrics.`,
    );
  };
  const groupDims = groupBy.map((f) => [f, resolve(f, "Dimension")] as const);
  const filterDims = where.map((f) => resolve(f.field, "Filter field"));

  // Project the measure table's own columns in a subquery so raw expressions stay unambiguous after joins.
  const srcCols = new Map<string, string>(); // alias -> expression in the base table
  const joins = new Map<string, { alias: string; target: SemanticModel; keyExpr: string; fkAlias: string; cols: Map<string, string> }>();
  const ref = (r: ResolvedDimension): string => {
    let col: string;
    if (!r.join) {
      const alias = `__c${srcCols.size}`;
      const existing = [...srcCols].find(([, expr]) => expr === r.column)?.[0];
      const a = existing ?? alias;
      srcCols.set(a, r.column);
      col = `src.${quoteIdent(a)}`;
    } else {
      const entity = r.join.entity.name;
      let j = joins.get(entity);
      if (!j) {
        const fkAlias = `__fk_${entity}`;
        srcCols.set(fkAlias, r.join.entity.expr ?? quoteIdent(r.join.entity.name));
        j = { alias: `j${joins.size}`, target: r.join.target, keyExpr: r.join.targetKey.expr ?? quoteIdent(r.join.targetKey.name), fkAlias, cols: new Map() };
        joins.set(entity, j);
      }
      const existing = [...j.cols].find(([, expr]) => expr === r.column)?.[0];
      const a = existing ?? `__c${j.cols.size}`;
      j.cols.set(a, r.column);
      col = `${j.alias}.${quoteIdent(a)}`;
    }
    return r.grain ? `cast(date_trunc('${r.grain}', ${col}) as date)` : col;
  };

  const selectDims = groupDims.map(([name, r]) => `${ref(r)} as ${quoteIdent(name)}`);
  const conds = filterDims.map((r, i) => filterSql(ref(r), where[i] as Filter));
  const aggs = g.measures.map((m) => {
    const a = `__m_${m.name}`;
    srcCols.set(a, m.expr ?? quoteIdent(m.name));
    return `${aggSql(m, `src.${quoteIdent(a)}`)} as ${quoteIdent(measureCol(m.name))}`;
  });

  const from = [
    `from (\n  select ${[...srcCols].map(([a, e]) => `${e} as ${quoteIdent(a)}`).join(", ")}\n  from ${relation(g.model)}\n) as src`,
    ...[...joins.values()].map(
      (j) =>
        `left join (\n  select ${j.keyExpr} as "__key", ${[...j.cols].map(([a, e]) => `${e} as ${quoteIdent(a)}`).join(", ")}\n  from ${relation(j.target)}\n) as ${j.alias}\n  on src.${quoteIdent(j.fkAlias)} = ${j.alias}."__key"`,
    ),
  ];
  return [
    `select\n  ${[...selectDims, ...aggs].join(",\n  ")}`,
    ...from,
    conds.length ? `where ${conds.join("\n  and ")}` : "",
    groupDims.length ? `group by ${groupDims.map((_, i) => i + 1).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** SQL for a metric over the joined, aggregated measures. */
function metricExpr(catalog: SemanticCatalog, name: string, depth = 0): string {
  if (depth > 20) throw new SemanticError(`Metric "${name}" nests too deeply.`);
  const m = catalog.getMetric(name);
  const tp = m.type_params;
  switch (m.type) {
    case "simple":
      return quoteIdent(measureCol(tp.measure!.name));
    case "ratio":
      return `cast(${metricExpr(catalog, tp.numerator!.name, depth + 1)} as double) / cast(nullif(${metricExpr(catalog, tp.denominator!.name, depth + 1)}, 0) as double)`;
    case "derived": {
      const inputs = new Map<string, MetricInput>((tp.metrics ?? []).map((i) => [i.alias ?? i.name, i]));
      // Replace each input metric's name (or alias) in the expression with its own SQL.
      const expr = tp.expr!.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (tok) => {
        const input = inputs.get(tok);
        return input ? `(${metricExpr(catalog, input.name, depth + 1)})` : tok;
      });
      return `(${expr})`;
    }
    default:
      throw new SemanticError(`Metric "${name}" has unsupported type "${m.type}".`);
  }
}

function aggSql(m: Measure, col: string): string {
  switch (m.agg) {
    case "sum":
      return `sum(${col})`;
    case "count":
      return `count(${col})`;
    case "count_distinct":
      return `count(distinct ${col})`;
    case "average":
    case "avg":
      return `avg(${col})`;
    case "min":
      return `min(${col})`;
    case "max":
      return `max(${col})`;
    case "median":
      return `median(${col})`;
    case "sum_boolean":
      return `sum(cast(${col} as integer))`;
    default:
      throw new SemanticError(`Measure "${m.name}" uses aggregation "${m.agg}", which this server does not support yet.`);
  }
}

export function filterSql(col: string, f: Filter): string {
  const v = f.value;
  switch (f.op) {
    case "is null":
    case "is not null":
      return `${col} ${f.op}`;
    case "in":
    case "not in": {
      if (!Array.isArray(v) || v.length === 0) throw new SemanticError(`"${f.op}" on "${f.field}" needs a non-empty list of values.`);
      return `${col} ${f.op} (${v.map(literal).join(", ")})`;
    }
    case "like":
    case "ilike":
      if (typeof v !== "string") throw new SemanticError(`"${f.op}" on "${f.field}" needs a string pattern.`);
      return `${col} ${f.op} ${literal(v)}`;
    case "=":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (v === undefined || Array.isArray(v)) throw new SemanticError(`"${f.op}" on "${f.field}" needs a single value.`);
      return `${col} ${f.op} ${literal(v)}`;
    default:
      throw new SemanticError(`Unknown filter operator "${(f as Filter).op}".`);
  }
}

/** Render a value as a SQL literal. Strings are quoted with '' escaping; nothing is spliced raw. */
export function literal(v: Scalar): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SemanticError(`Filter value ${v} is not a finite number.`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v !== "string") throw new SemanticError("Filter values must be strings, numbers or booleans.");
  return `'${v.replace(/'/g, "''")}'`;
}

/** Use schema + table only: the database (catalog) name comes from the file name and changes if it's renamed. */
function relation(model: SemanticModel): string {
  return `${quoteIdent(model.node_relation.schema_name)}.${quoteIdent(model.node_relation.alias)}`;
}

const measureCol = (name: string) => `__m__${name}`;
const unique = <T>(xs: T[]) => [...new Set(xs)];
const indent = (s: string) => s.replace(/^/gm, "  ");
