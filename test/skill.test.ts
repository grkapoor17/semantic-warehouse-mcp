/**
 * Keeps the Agent Skill honest: valid frontmatter, links that resolve, tool names that exist, and
 * every query_metrics example in the patterns file runs on the FPL warehouse (when it's built).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBAdapter } from "../src/adapters/duckdb.js";
import { SemanticCatalog } from "../src/semantic/catalog.js";
import { compileMetricQuery, type MetricQuery } from "../src/semantic/compile.js";
import type { SemanticManifest } from "../src/semantic/manifest.js";
import { createServer } from "../src/server.js";
import { makeShopDb, shopManifest } from "./semantic-fixture.js";

const SKILL = "skills/warehouse-analysis/SKILL.md";
const skill = readFileSync(SKILL, "utf8");
const [, frontmatter = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill) ?? [];
const field = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(frontmatter)?.[1]?.trim() ?? "";

describe("SKILL.md", () => {
  it("has valid frontmatter", () => {
    expect(field("name")).toBe("warehouse-analysis");
    expect(field("name")).toMatch(/^[a-z0-9-]{1,64}$/);
    const description = field("description");
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
  });

  it("stays short enough to load cheaply", () => {
    expect(body.split("\n").length).toBeLessThan(200);
  });

  it("links only to files that exist", () => {
    const links = [...body.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(join(dirname(SKILL), l)), l).toBe(true);
  });

  it("names only tools the server actually has", async () => {
    const fx = await makeShopDb();
    const adapter = await DuckDBAdapter.open(fx.path);
    const server = createServer({ adapter, semanticManifest: shopManifest });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const real = new Set((await client.listTools()).tools.map((t) => t.name));
    await client.close();
    await adapter.close();
    fx.cleanup();

    const mentioned = new Set([...skill.matchAll(/\b(list_\w+|describe_\w+|run_\w+|query_\w+)\b/g)].map((m) => m[1]!));
    expect(mentioned.size).toBeGreaterThanOrEqual(6);
    for (const t of mentioned) expect(real.has(t), `SKILL.md mentions unknown tool ${t}`).toBe(true);
  });
});

// ---- the patterns file -------------------------------------------------------------------------

const patterns = readFileSync("skills/warehouse-analysis/references/query-patterns.md", "utf8");
const examples: MetricQuery[] = [...patterns.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((m) =>
  m[1]!
    .trim()
    .split(/\n(?=\{)/) // a block may hold several one-line calls
    .map((s) => JSON.parse(s) as MetricQuery),
);

it("query-patterns.md examples are valid JSON", () => {
  expect(examples.length).toBeGreaterThanOrEqual(8);
});

const DB = "examples/fpl/data/fpl.duckdb";
const MANIFEST = "examples/fpl/target/semantic_manifest.json";

describe.skipIf(!existsSync(DB) || !existsSync(MANIFEST))("query-patterns.md examples run on the FPL warehouse", () => {
  let adapter: DuckDBAdapter;
  let catalog: SemanticCatalog;
  beforeAll(async () => {
    adapter = await DuckDBAdapter.open(DB, { allowedSchemas: ["marts"] });
    catalog = new SemanticCatalog(JSON.parse(readFileSync(MANIFEST, "utf8")) as SemanticManifest);
  });
  afterAll(() => adapter?.close());

  it.each(examples.map((q, i) => [i + 1, q] as const))("example %i returns rows", async (_, q) => {
    const r = await adapter.query(compileMetricQuery(catalog, q), { maxRows: 500, timeoutMs: 30_000 });
    expect(r.rows.length).toBeGreaterThan(0);
  });
});
