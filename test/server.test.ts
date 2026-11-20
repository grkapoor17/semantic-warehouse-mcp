import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBAdapter } from "../src/adapters/duckdb.js";
import { createServer } from "../src/server.js";
import { makeFixtureDb } from "./fixture.js";

let client: Client;
let adapter: DuckDBAdapter;
let cleanup: () => void;

beforeAll(async () => {
  const fx = await makeFixtureDb();
  cleanup = fx.cleanup;
  adapter = await DuckDBAdapter.open(fx.path);
  const server = createServer({ adapter, limits: { maxRows: 5 } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterAll(async () => {
  await client.close();
  await adapter.close();
  cleanup();
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("");

describe("MCP surface", () => {
  it("exposes three read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["describe_table", "list_tables", "run_query"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "run_query")?.description).toContain("At most 5 rows");
  });

  it("list_tables returns JSON", async () => {
    const r = await client.callTool({ name: "list_tables", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).tables).toHaveLength(3);
  });

  it("run_query applies the configured row cap", async () => {
    const r = await client.callTool({ name: "run_query", arguments: { sql: "select * from player_gameweeks" } });
    const body = JSON.parse(text(r));
    expect(body.rows).toHaveLength(5);
    expect(body.truncated).toBe(true);
  });

  it("guard refusals come back as tool errors the model can read", async () => {
    const r = await client.callTool({ name: "run_query", arguments: { sql: "drop table teams" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Refused \(statement_not_allowed\)/);
  });

  it("SQL errors come back as tool errors too", async () => {
    const r = await client.callTool({ name: "run_query", arguments: { sql: "select nope from teams" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^SQL error: .*nope/);
  });
});

describe("semantic tools", () => {
  let sclient: Client;
  let sadapter: DuckDBAdapter;
  let scleanup: () => void;

  beforeAll(async () => {
    const { makeShopDb, shopManifest } = await import("./semantic-fixture.js");
    const fx = await makeShopDb();
    scleanup = fx.cleanup;
    sadapter = await DuckDBAdapter.open(fx.path, { allowedSchemas: ["shop"] });
    const server = createServer({ adapter: sadapter, semanticManifest: shopManifest });
    const [c, s] = InMemoryTransport.createLinkedPair();
    sclient = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), sclient.connect(c)]);
  });
  afterAll(async () => {
    await sclient.close();
    await sadapter.close();
    scleanup();
  });

  it("are only registered when a semantic manifest is given, with server instructions", async () => {
    expect((await client.listTools()).tools).toHaveLength(3);
    const names = (await sclient.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_table", "list_dimensions", "list_metrics", "list_tables", "query_metrics", "run_query"]);
    expect(sclient.getInstructions()).toMatch(/prefer|instead of writing SQL/i);
    expect(client.getInstructions()).toBeUndefined();
  });

  it("query_metrics returns rows and the SQL it ran", async () => {
    const r = await sclient.callTool({
      name: "query_metrics",
      arguments: { metrics: ["revenue"], group_by: ["customer__country"], order_by: [{ field: "revenue", descending: true }] },
    });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r));
    expect(body.rows).toEqual([
      { customer__country: "US", revenue: 170 },
      { customer__country: "UK", revenue: 30 },
    ]);
    expect(body.sql).toMatch(/left join/);
  });

  it("list_dimensions narrows to what every metric supports", async () => {
    const r = await sclient.callTool({ name: "list_dimensions", arguments: { metrics: ["revenue", "refunds"] } });
    expect(JSON.parse(text(r)).dimensions.map((d: { name: string }) => d.name)).toEqual(["metric_time"]);
  });

  it("bad metric queries come back as readable tool errors", async () => {
    const r = await sclient.callTool({ name: "query_metrics", arguments: { metrics: ["revenu"] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Invalid metric query: Unknown metric "revenu". Did you mean "revenue"/);
  });

  it("invalid filter operators are rejected by the input schema", async () => {
    const r = await sclient.callTool({
      name: "query_metrics",
      arguments: { metrics: ["revenue"], where: [{ field: "customer__country", op: "; drop", value: "x" }] },
    });
    expect(r.isError).toBe(true);
  });
});
