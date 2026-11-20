import { readFile } from "node:fs/promises";

/**
 * The subset of dbt's `target/semantic_manifest.json` (MetricFlow's input) that this server reads.
 * `dbt parse` writes it; we never run dbt or MetricFlow ourselves.
 */
export interface SemanticManifest {
  semantic_models: SemanticModel[];
  metrics: Metric[];
}

export interface SemanticModel {
  name: string;
  description?: string | null;
  node_relation: { alias: string; schema_name: string; database?: string | null; relation_name?: string | null };
  defaults?: { agg_time_dimension?: string | null } | null;
  primary_entity?: string | null;
  entities: Entity[];
  dimensions: Dimension[];
  measures: Measure[];
}

export interface Entity {
  name: string;
  type: "primary" | "unique" | "natural" | "foreign";
  expr?: string | null;
  description?: string | null;
}

export type TimeGrain = "day" | "week" | "month" | "quarter" | "year";

export interface Dimension {
  name: string;
  type: "categorical" | "time";
  expr?: string | null;
  description?: string | null;
  label?: string | null;
  type_params?: { time_granularity?: string | null } | null;
}

export interface Measure {
  name: string;
  agg: string;
  expr?: string | null;
  description?: string | null;
  agg_params?: unknown;
  non_additive_dimension?: unknown;
  agg_time_dimension?: string | null;
}

export interface MetricInput {
  name: string;
  alias?: string | null;
  filter?: unknown;
  offset_window?: unknown;
  offset_to_grain?: unknown;
  join_to_timespine?: boolean | null;
  fill_nulls_with?: number | null;
}

export interface Metric {
  name: string;
  label?: string | null;
  description?: string | null;
  type: "simple" | "ratio" | "derived" | "cumulative" | "conversion";
  filter?: unknown;
  type_params: {
    measure?: MetricInput | null;
    numerator?: MetricInput | null;
    denominator?: MetricInput | null;
    expr?: string | null;
    metrics?: MetricInput[] | null;
    join_to_timespine?: boolean | null;
    fill_nulls_with?: number | null;
  };
}

export async function loadManifest(path: string): Promise<SemanticManifest> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SemanticManifest>;
  if (!Array.isArray(raw.semantic_models) || !Array.isArray(raw.metrics)) {
    throw new Error(`${path} does not look like a dbt semantic_manifest.json (run \`dbt parse\` to create it).`);
  }
  return raw as SemanticManifest;
}
