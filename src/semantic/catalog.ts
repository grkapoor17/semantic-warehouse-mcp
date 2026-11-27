import type { Dimension, Entity, Measure, Metric, MetricInput, SemanticManifest, SemanticModel, TimeGrain } from "./manifest.js";

/** A metric query the server can't answer as asked (unknown name, unsupported feature, unreachable dimension...). */
export class SemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticError";
  }
}

export const GRAINS: readonly TimeGrain[] = ["day", "week", "month", "quarter", "year"];

/** A dimension as the agent sees it in list_dimensions. */
export interface DimensionInfo {
  name: string;
  type: "categorical" | "time" | "entity";
  description: string | null;
  /** For time dimensions: the grains you can append, e.g. `metric_time__month`. */
  grains?: TimeGrain[];
}

/**
 * How to compute one dimension for one measure group. `column` is a SQL expression evaluated inside
 * the measure model's table (join = null) or inside the joined model's table.
 */
export interface ResolvedDimension {
  info: DimensionInfo;
  join: { entity: Entity; target: SemanticModel; targetKey: Entity } | null;
  column: string;
  grain: TimeGrain | null;
}

/** Measures that share a table and a time dimension, so they can be aggregated in one subquery. */
export interface MeasureGroup {
  key: string;
  model: SemanticModel;
  aggTimeDimension: Dimension | null;
  measures: Measure[];
}

const UNSUPPORTED_AGGS = new Set(["percentile"]);

export class SemanticCatalog {
  private readonly metrics = new Map<string, Metric>();
  private readonly measureModel = new Map<string, { measure: Measure; model: SemanticModel }>();
  /** entity name -> the model where it is the primary (or unique/natural) key */
  private readonly entityHome = new Map<string, { model: SemanticModel; entity: Entity }>();

  constructor(readonly manifest: SemanticManifest) {
    for (const m of manifest.metrics) this.metrics.set(m.name, m);
    for (const model of manifest.semantic_models) {
      for (const measure of model.measures ?? []) this.measureModel.set(measure.name, { measure, model });
      for (const e of model.entities ?? []) {
        if (e.type !== "foreign" && !this.entityHome.has(e.name)) this.entityHome.set(e.name, { model, entity: e });
      }
    }
  }

  /**
   * The metric catalogue. Each metric carries `notes`: the descriptions of the semantic models its
   * measures come from. Table-level caveats ("includes managers; filter position != 'MGR'") are
   * usually written there, not on each metric, and v1 of the eval showed agents never saw them.
   */
  listMetrics(): { name: string; label: string | null; type: string; description: string | null; notes?: string[] }[] {
    return [...this.metrics.values()]
      .map((m) => {
        const notes = this.modelNotes(m.name);
        return {
          name: m.name,
          label: m.label ?? null,
          type: m.type,
          description: m.description || null,
          ...(notes.length ? { notes } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Descriptions of the semantic models behind a metric (empty if none, or if the metric can't be compiled). */
  private modelNotes(metricName: string): string[] {
    let measures: Measure[];
    try {
      measures = this.measuresOf(metricName);
    } catch {
      return [];
    }
    const models = new Set(measures.map((ms) => this.measureModel.get(ms.name)!.model));
    return [...models].map((md) => md.description?.trim().replace(/\s+/g, " ")).filter((d): d is string => Boolean(d));
  }

  getMetric(name: string): Metric {
    const m = this.metrics.get(name);
    if (!m) throw new SemanticError(`Unknown metric "${name}".${suggest(name, [...this.metrics.keys()])} Call list_metrics.`);
    return m;
  }

  /** All measures a metric needs, recursing through ratio/derived inputs. Rejects features we don't compile. */
  measuresOf(metricName: string, seen: string[] = []): Measure[] {
    if (seen.includes(metricName)) throw new SemanticError(`Metric cycle: ${[...seen, metricName].join(" -> ")}`);
    const m = this.getMetric(metricName);
    const where = `metric "${m.name}"`;
    if (m.filter) unsupported(where, "a metric-level filter");
    if (m.type_params.join_to_timespine || m.type_params.fill_nulls_with != null) unsupported(where, "join_to_timespine / fill_nulls_with");
    const path = [...seen, metricName];
    switch (m.type) {
      case "simple": {
        const input = m.type_params.measure;
        if (!input) throw new SemanticError(`${where} has no measure.`);
        checkInput(where, input);
        if (input.join_to_timespine || input.fill_nulls_with != null) unsupported(where, "join_to_timespine / fill_nulls_with");
        const found = this.measureModel.get(input.name);
        if (!found) throw new SemanticError(`${where} uses unknown measure "${input.name}".`);
        if (UNSUPPORTED_AGGS.has(found.measure.agg) || found.measure.agg_params) unsupported(where, `the ${found.measure.agg} aggregation`);
        if (found.measure.non_additive_dimension) unsupported(where, "a non-additive dimension");
        return [found.measure];
      }
      case "ratio": {
        const { numerator, denominator } = m.type_params;
        if (!numerator || !denominator) throw new SemanticError(`${where} needs a numerator and denominator.`);
        checkInput(where, numerator);
        checkInput(where, denominator);
        return [...this.measuresOf(numerator.name, path), ...this.measuresOf(denominator.name, path)];
      }
      case "derived": {
        const inputs = m.type_params.metrics ?? [];
        if (!m.type_params.expr || inputs.length === 0) throw new SemanticError(`${where} needs an expr and input metrics.`);
        return inputs.flatMap((i) => {
          checkInput(where, i);
          return this.measuresOf(i.name, path);
        });
      }
      default:
        return unsupported(where, `the "${m.type}" metric type`);
    }
  }

  /** Group the measures behind a set of metrics by (table, time dimension). */
  measureGroups(metricNames: string[]): MeasureGroup[] {
    const groups = new Map<string, MeasureGroup>();
    for (const name of metricNames) {
      for (const measure of this.measuresOf(name)) {
        const model = this.measureModel.get(measure.name)!.model;
        const timeName = measure.agg_time_dimension ?? model.defaults?.agg_time_dimension ?? null;
        const aggTimeDimension = timeName ? (model.dimensions.find((d) => d.name === timeName) ?? null) : null;
        const key = `${model.name}|${timeName ?? ""}`;
        const group = groups.get(key) ?? { key, model, aggTimeDimension, measures: [] };
        if (!group.measures.some((x) => x.name === measure.name)) group.measures.push(measure);
        groups.set(key, group);
      }
    }
    return [...groups.values()];
  }

  /** Every dimension name that can be computed for a measure group, mapped to how to compute it. */
  dimensionsFor(group: MeasureGroup): Map<string, ResolvedDimension> {
    const out = new Map<string, ResolvedDimension>();
    const { model } = group;

    // metric_time: the measure's own time dimension, under a name shared by every table.
    if (group.aggTimeDimension) {
      addTime(out, "metric_time", group.aggTimeDimension, null, "The time each measure is aggregated on (kickoff/match date here).");
    }

    // Columns of the measure's own table, addressed through its primary entity.
    const primary = primaryEntity(model);
    if (primary) {
      for (const d of model.dimensions) addDimension(out, `${primary.name}__${d.name}`, d, null);
    }

    // Entities themselves (group by the key), and one hop to the tables where they are the primary key.
    for (const e of model.entities) {
      out.set(e.name, {
        info: { name: e.name, type: "entity", description: e.description || `Key: ${e.expr ?? e.name}` },
        join: null,
        column: e.expr ?? quoteIdent(e.name),
        grain: null,
      });
      const home = this.entityHome.get(e.name);
      if (!home || home.model === model) continue;
      for (const d of home.model.dimensions) {
        addDimension(out, `${e.name}__${d.name}`, d, { entity: e, target: home.model, targetKey: home.entity });
      }
    }
    return out;
  }

  /** Dimensions usable with ALL of the given metrics (what list_dimensions shows). */
  commonDimensions(metricNames: string[]): DimensionInfo[] {
    const groups = this.measureGroups(metricNames);
    const maps = groups.map((g) => this.dimensionsFor(g));
    const first = maps[0];
    if (!first) return [];
    const names = [...first.keys()].filter((n) => maps.every((m) => m.has(n)));
    const infos = names.map((n) => first.get(n)!.info);
    // Collapse "x__month", "x__year"... into the base time dimension with a grains list.
    return infos.filter((i) => !GRAINS.some((g) => i.name.endsWith(`__${g}`) && first.get(i.name)?.grain)).sort(byName);
  }
}

function addDimension(out: Map<string, ResolvedDimension>, name: string, d: Dimension, join: ResolvedDimension["join"]) {
  if (d.type === "time") return addTime(out, name, d, join, d.description ?? null);
  out.set(name, {
    info: { name, type: "categorical", description: d.description || null },
    join,
    column: d.expr ?? quoteIdent(d.name),
    grain: null,
  });
}

function addTime(out: Map<string, ResolvedDimension>, name: string, d: Dimension, join: ResolvedDimension["join"], description: string | null) {
  const base = (d.type_params?.time_granularity ?? "day") as TimeGrain;
  const grains = GRAINS.slice(Math.max(0, GRAINS.indexOf(base)));
  const column = d.expr ?? quoteIdent(d.name);
  const info: DimensionInfo = { name, type: "time", description: description || null, grains };
  out.set(name, { info, join, column, grain: null });
  for (const g of grains) out.set(`${name}__${g}`, { info: { ...info, name: `${name}__${g}` }, join, column, grain: g });
}

export function primaryEntity(model: SemanticModel): Entity | undefined {
  if (model.primary_entity) {
    return model.entities.find((e) => e.name === model.primary_entity) ?? { name: model.primary_entity, type: "primary" };
  }
  return model.entities.find((e) => e.type === "primary");
}

function checkInput(where: string, input: MetricInput) {
  if (input.filter) unsupported(where, `a filter on input "${input.name}"`);
  if (input.offset_window || input.offset_to_grain) unsupported(where, `a time offset on input "${input.name}"`);
}

function unsupported(where: string, what: string): never {
  throw new SemanticError(`${where} uses ${what}, which this server does not support yet. Use run_query for this one.`);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** " Did you mean ...?" for typos, or "" when nothing is close. */
export function suggest(input: string, candidates: string[]): string {
  const lc = input.toLowerCase();
  // Rank by edit distance; a candidate that contains what was typed (e.g. "points" -> "total_points") counts as close.
  const scored = candidates
    .map((c) => ({ c, d: c.toLowerCase().includes(lc) ? Math.min(1, editDistance(lc, c.toLowerCase())) : editDistance(lc, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(input.length / 3)))
    .sort((a, b) => a.d - b.d || a.c.length - b.c.length)
    .slice(0, 3);
  return scored.length ? ` Did you mean ${scored.map((x) => `"${x.c}"`).join(" or ")}?` : "";
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
