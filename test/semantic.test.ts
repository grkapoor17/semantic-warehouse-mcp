import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBAdapter } from "../src/adapters/duckdb.js";
import { SemanticCatalog, SemanticError } from "../src/semantic/catalog.js";
import { compileMetricQuery, literal, type MetricQuery } from "../src/semantic/compile.js";
import { makeShopDb, shopManifest } from "./semantic-fixture.js";

let adapter: DuckDBAdapter;
let cleanup: () => void;
const catalog = new SemanticCatalog(shopManifest);

beforeAll(async () => {
  const fx = await makeShopDb();
  cleanup = fx.cleanup;
  adapter = await DuckDBAdapter.open(fx.path, { allowedSchemas: ["shop"] });
});
afterAll(async () => {
  await adapter.close();
  cleanup();
});

const run = async (q: MetricQuery) => (await adapter.query(compileMetricQuery(catalog, q), { maxRows: 100, timeoutMs: 5000 })).rows;
const fails = (q: MetricQuery) => {
  try {
    compileMetricQuery(catalog, q);
  } catch (e) {
    expect(e).toBeInstanceOf(SemanticError);
    return (e as Error).message;
  }
  throw new Error("expected a SemanticError");
};

describe("compiling metrics", () => {
  it("sums a simple metric with no group-by", async () => {
    expect(await run({ metrics: ["revenue", "orders"] })).toEqual([{ revenue: 200, orders: 4 }]);
  });

  it("groups by a dimension joined through an entity", async () => {
    const rows = await run({ metrics: ["revenue"], group_by: ["customer__country"], order_by: [{ field: "customer__country" }] });
    expect(rows).toEqual([
      { customer__country: "UK", revenue: 30 },
      { customer__country: "US", revenue: 170 },
    ]);
  });

  it("groups by the entity key itself and by local dimensions", async () => {
    const rows = await run({ metrics: ["orders"], group_by: ["customer", "order__status"], order_by: [{ field: "customer" }] });
    expect(rows).toEqual([
      { customer: 1, order__status: "paid", orders: 2 },
      { customer: 2, order__status: "paid", orders: 1 },
      { customer: 3, order__status: "refunded", orders: 1 },
    ]);
  });

  it("supports count_distinct and average", async () => {
    expect(await run({ metrics: ["buyers", "avg_order_value"] })).toEqual([{ buyers: 3, avg_order_value: 50 }]);
  });

  it("computes ratios after aggregating (not an average of per-row ratios)", async () => {
    const rows = await run({ metrics: ["revenue_per_order"], group_by: ["customer__name"], order_by: [{ field: "customer__name" }] });
    expect(rows).toEqual([
      { customer__name: "Ana", revenue_per_order: 75 },
      { customer__name: "Bo", revenue_per_order: 30 },
      { customer__name: "O'Brien", revenue_per_order: 20 },
    ]);
  });

  it("joins metrics from two tables on metric_time and computes nested derived metrics", async () => {
    const rows = await run({
      metrics: ["revenue", "refunds", "net_revenue", "net_share"],
      group_by: ["metric_time__month"],
      order_by: [{ field: "metric_time__month" }],
    });
    expect(rows).toEqual([
      { metric_time__month: "2024-01-01", revenue: 100, refunds: null, net_revenue: null, net_share: null },
      { metric_time__month: "2024-02-01", revenue: 80, refunds: null, net_revenue: null, net_share: null },
      { metric_time__month: "2024-03-01", revenue: 20, refunds: 25, net_revenue: -5, net_share: -0.25 },
    ]);
  });

  it("returns null, not an error, when a ratio divides by zero/null", async () => {
    expect(await run({ metrics: ["zero_div"], group_by: ["metric_time__year"] })).toEqual([{ metric_time__year: "2024-01-01", zero_div: 8 }]);
    const rows = await run({ metrics: ["zero_div"], group_by: ["metric_time__month"], order_by: [{ field: "metric_time__month" }] });
    expect(rows.map((r) => r.zero_div)).toEqual([null, null, 0.8]);
  });

  it("applies where (before aggregating), having (after), order and limit", async () => {
    const rows = await run({
      metrics: ["revenue", "orders"],
      group_by: ["customer__name"],
      where: [{ field: "metric_time", op: ">=", value: "2024-02-01" }],
      having: [{ field: "revenue", op: ">", value: 25 }],
      order_by: [{ field: "revenue", descending: true }],
      limit: 1,
    });
    expect(rows).toEqual([{ customer__name: "Ana", revenue: 50, orders: 1 }]);
  });

  it("supports in / not in / ilike / is null filters", async () => {
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__country", op: "in", value: ["UK", "FR"] }] })).toEqual([{ orders: 1 }]);
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__country", op: "not in", value: ["UK"] }] })).toEqual([{ orders: 3 }]);
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__name", op: "ilike", value: "%o%" }] })).toEqual([{ orders: 2 }]);
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__name", op: "is null" }] })).toEqual([{ orders: 0 }]);
  });

  it("treats filter values as data, never as SQL", async () => {
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__name", op: "=", value: "O'Brien" }] })).toEqual([{ orders: 1 }]);
    const attack = "x' or 1=1 --";
    expect(await run({ metrics: ["orders"], where: [{ field: "customer__name", op: "=", value: attack }] })).toEqual([{ orders: 0 }]);
    expect(literal(attack)).toBe("'x'' or 1=1 --'");
  });

  it("only reads from the semantic models' own tables", () => {
    const sql = compileMetricQuery(catalog, { metrics: ["net_revenue"], group_by: ["metric_time__month"] });
    expect(sql).toContain('"shop"."orders"');
    expect(sql).toContain('"shop"."refunds"');
    expect(sql).not.toContain("internal");
  });
});

describe("what the agent sees", () => {
  it("lists metrics with descriptions", () => {
    expect(catalog.listMetrics().find((m) => m.name === "revenue")).toEqual({
      name: "revenue",
      label: null,
      type: "simple",
      description: "Gross order value",
    });
  });

  it("lists dimensions usable with every requested metric, time dims with grains", () => {
    const one = catalog.commonDimensions(["revenue"]).map((d) => d.name);
    expect(one).toEqual(["customer", "customer__country", "customer__name", "metric_time", "order", "order__ordered_at", "order__status"]);
    const mt = catalog.commonDimensions(["revenue"]).find((d) => d.name === "metric_time");
    expect(mt?.grains).toEqual(["day", "week", "month", "quarter", "year"]);
    // Refunds have no customer, so only metric_time is shared.
    expect(catalog.commonDimensions(["revenue", "refunds"]).map((d) => d.name)).toEqual(["metric_time"]);
  });
});

describe("helpful errors", () => {
  it("suggests close metric and dimension names", () => {
    expect(fails({ metrics: ["revenu"] })).toMatch(/Unknown metric "revenu". Did you mean "revenue"/);
    expect(fails({ metrics: ["revenue"], group_by: ["customer__contry"] })).toMatch(/Did you mean "customer__country"/);
  });

  it("explains which metric can't use a dimension", () => {
    expect(fails({ metrics: ["revenue", "refunds"], group_by: ["customer__country"] })).toMatch(
      /"customer__country" is not available for "refunds"/,
    );
  });

  it("refuses features it doesn't compile instead of guessing", () => {
    expect(fails({ metrics: ["paid_revenue"] })).toMatch(/metric-level filter.*not support/);
    expect(fails({ metrics: ["p90_order"] })).toMatch(/percentile aggregation/);
  });

  it("validates order_by, having, filter values and limit", () => {
    expect(fails({ metrics: ["revenue"], order_by: [{ field: "orders" }] })).toMatch(/order_by "orders"/);
    expect(fails({ metrics: ["revenue"], having: [{ field: "orders", op: ">", value: 1 }] })).toMatch(/having/);
    expect(fails({ metrics: ["revenue"], where: [{ field: "customer__country", op: "in", value: "US" }] })).toMatch(/non-empty list/);
    expect(fails({ metrics: ["revenue"], limit: 0 })).toMatch(/limit/);
    expect(fails({ metrics: [] })).toMatch(/at least one metric/);
  });
});
