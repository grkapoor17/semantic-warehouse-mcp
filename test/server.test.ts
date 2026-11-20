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
