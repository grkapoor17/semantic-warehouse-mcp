import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SemanticManifest } from "../src/semantic/manifest.js";

/**
 * A tiny shop small enough to check every number by hand:
 *   customers: 1 Ana (US), 2 Bo (UK), 3 O'Brien (US)
 *   orders:    10 Ana 2024-01-05 $100 · 11 Ana 2024-02-10 $50 · 12 Bo 2024-02-20 $30 · 13 O'Brien 2024-03-01 $20 (status refunded)
 *   refunds:   2024-03-02 $20 · 2024-03-15 $5
 * Revenue: Jan 100, Feb 80, Mar 20 = 200. Refunds: Mar 25. US revenue 170, UK 30.
 */
export async function makeShopDb(): Promise<{ path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "swmcp-shop-"));
  const path = join(dir, "warehouse.duckdb");
  const db = await DuckDBInstance.create(path);
  const c = await db.connect();
  await c.run(`
    create schema shop;
    create table shop.customers (customer_id int, name varchar, country varchar);
    insert into shop.customers values (1, 'Ana', 'US'), (2, 'Bo', 'UK'), (3, 'O''Brien', 'US');
    create table shop.orders (order_id int, customer_id int, ordered_at date, amount decimal(10,2), status varchar);
    insert into shop.orders values
      (10, 1, '2024-01-05', 100, 'paid'), (11, 1, '2024-02-10', 50, 'paid'),
      (12, 2, '2024-02-20', 30, 'paid'), (13, 3, '2024-03-01', 20, 'refunded');
    create table shop.refunds (refund_id int, refunded_at date, refund_amount decimal(10,2));
    insert into shop.refunds values (1, '2024-03-02', 20), (2, '2024-03-15', 5);
    create schema internal;
    create table internal.secrets (s varchar);
    insert into internal.secrets values ('do not read');
  `);
  c.closeSync();
  db.closeSync();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const rel = (alias: string) => ({ alias, schema_name: "shop", database: "shop" });
const simple = (name: string, measure: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: "simple" as const,
  type_params: { measure: { name: measure } },
  ...extra,
});

export const shopManifest: SemanticManifest = {
  semantic_models: [
    {
      name: "orders",
      node_relation: rel("orders"),
      defaults: { agg_time_dimension: "ordered_at" },
      entities: [
        { name: "order", type: "primary", expr: "order_id" },
        { name: "customer", type: "foreign", expr: "customer_id" },
      ],
      dimensions: [
        { name: "ordered_at", type: "time", type_params: { time_granularity: "day" } },
        { name: "status", type: "categorical", description: "paid or refunded" },
      ],
      measures: [
        { name: "revenue", agg: "sum", expr: "amount" },
        { name: "order_count", agg: "count", expr: "order_id" },
        { name: "buyers", agg: "count_distinct", expr: "customer_id" },
        { name: "avg_order", agg: "average", expr: "amount" },
        { name: "p90_order", agg: "percentile", expr: "amount", agg_params: { percentile: 0.9 } },
      ],
    },
    {
      name: "customers",
      node_relation: rel("customers"),
      entities: [{ name: "customer", type: "primary", expr: "customer_id" }],
      dimensions: [
        { name: "name", type: "categorical" },
        { name: "country", type: "categorical", description: "ISO country" },
      ],
      measures: [],
    },
    {
      name: "refunds",
      node_relation: rel("refunds"),
      defaults: { agg_time_dimension: "refunded_at" },
      entities: [{ name: "refund", type: "primary", expr: "refund_id" }],
      dimensions: [{ name: "refunded_at", type: "time", type_params: { time_granularity: "day" } }],
      measures: [{ name: "refunded", agg: "sum", expr: "refund_amount" }],
    },
  ],
  metrics: [
    simple("revenue", "revenue", { description: "Gross order value" }),
    simple("orders", "order_count"),
    simple("buyers", "buyers"),
    simple("avg_order_value", "avg_order"),
    simple("refunds", "refunded"),
    { name: "revenue_per_order", type: "ratio", type_params: { numerator: { name: "revenue" }, denominator: { name: "orders" } } },
    { name: "net_revenue", type: "derived", type_params: { expr: "revenue - refunds", metrics: [{ name: "revenue" }, { name: "refunds" }] } },
    {
      name: "net_share",
      type: "derived",
      type_params: { expr: "net / gross", metrics: [{ name: "net_revenue", alias: "net" }, { name: "revenue", alias: "gross" }] },
    },
    { name: "zero_div", type: "ratio", type_params: { numerator: { name: "revenue" }, denominator: { name: "refunds" } } },
    simple("p90_order", "p90_order"),
    simple("paid_revenue", "revenue", { filter: { where_filters: [{ where_sql_template: "{{ Dimension('order__status') }} = 'paid'" }] } }),
  ],
};
