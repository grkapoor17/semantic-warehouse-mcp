/**
 * Parity with MetricFlow, dbt's reference engine, on the real FPL warehouse.
 * Expected rows come from examples/fpl/make_parity_fixtures.py (MetricFlow's own answers).
 * Skipped when the warehouse hasn't been built (CI doesn't download the data): run examples/fpl/build.sh first.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBAdapter } from "../src/adapters/duckdb.js";
import { SemanticCatalog } from "../src/semantic/catalog.js";
import { compileMetricQuery, type MetricQuery } from "../src/semantic/compile.js";
import type { SemanticManifest } from "../src/semantic/manifest.js";

const DB = "examples/fpl/fpl.duckdb";
const MANIFEST = "examples/fpl/target/semantic_manifest.json";
const ready = existsSync(DB) && existsSync(MANIFEST);

const cases = JSON.parse(readFileSync("test/fixtures/fpl-parity-cases.json", "utf8")) as { name: string; query: MetricQuery }[];
const expected = JSON.parse(readFileSync("test/fixtures/fpl-parity-expected.json", "utf8")) as {
  name: string;
  rows: Record<string, unknown>[];
}[];

describe.skipIf(!ready)("parity with MetricFlow on the FPL warehouse", () => {
  let adapter: DuckDBAdapter;
  let catalog: SemanticCatalog;

  beforeAll(async () => {
    adapter = await DuckDBAdapter.open(DB, { allowedSchemas: ["marts"] });
    catalog = new SemanticCatalog(JSON.parse(readFileSync(MANIFEST, "utf8")) as SemanticManifest);
  });
  afterAll(() => adapter?.close());

  it.each(cases.map((c, i) => [c.name, c, expected[i]!] as const))("%s", async (_, c, exp) => {
    expect(exp.name).toBe(c.name);
    const sql = compileMetricQuery(catalog, c.query);
    const got = await adapter.query(sql, { maxRows: 1000, timeoutMs: 30_000 });
    expect(got.rows.map(normalise)).toEqual(exp.rows.map(normalise));
  });
});

/** Compare values the way a person would: numbers to 9 significant digits, dates by calendar day. */
function normalise(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (typeof v === "number") return [k, Number(v.toPrecision(9))];
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}([ T]00:00:00)?$/.test(v)) return [k, v.slice(0, 10)];
      return [k, v];
    }),
  );
}
