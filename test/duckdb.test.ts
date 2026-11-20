import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBAdapter } from "../src/adapters/duckdb.js";
import { GuardError } from "../src/adapters/types.js";
import { makeFixtureDb } from "./fixture.js";

const LIMITS = { maxRows: 100, timeoutMs: 5_000 };

let adapter: DuckDBAdapter;
let cleanup: () => void;

beforeAll(async () => {
  const fx = await makeFixtureDb();
  cleanup = fx.cleanup;
  adapter = await DuckDBAdapter.open(fx.path);
});

afterAll(async () => {
  await adapter.close();
  cleanup();
});

describe("metadata", () => {
  it("lists tables and views with schema-qualified names", async () => {
    const tables = await adapter.listTables();
    expect(tables.map((t) => t.name)).toEqual(["main.player_gameweeks", "main.teams", "marts.team_points"]);
    expect(tables.find((t) => t.name === "main.teams")?.comment).toBe("One row per Premier League club.");
    expect(tables.find((t) => t.name === "marts.team_points")?.kind).toBe("view");
  });

  it("describes a table by qualified or unambiguous bare name", async () => {
    const a = await adapter.describeTable("main.teams");
    const b = await adapter.describeTable("TEAMS");
    expect(a).toEqual(b);
    expect(a.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["team_id", "INTEGER", false],
      ["name", "VARCHAR", false],
      ["short_name", "VARCHAR", true],
    ]);
  });

  it("refuses unknown tables with a hint", async () => {
    await expect(adapter.describeTable("nope")).rejects.toMatchObject({ code: "table_not_found" });
  });
});

describe("query", () => {
  it("runs a SELECT and returns typed columns", async () => {
    const r = await adapter.query("select name, points from marts.team_points order by name", LIMITS);
    expect(r.columns.map((c) => c.name)).toEqual(["name", "points"]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ name: "Arsenal" });
    expect(r.truncated).toBe(false);
  });

  it("allows CTEs and EXPLAIN", async () => {
    await expect(adapter.query("with x as (select 1 as a) select * from x", LIMITS)).resolves.toBeTruthy();
    await expect(adapter.query("explain select * from teams", LIMITS)).resolves.toBeTruthy();
  });

  it("caps rows and flags truncation", async () => {
    const r = await adapter.query("select * from player_gameweeks", { ...LIMITS, maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("does not flag truncation when the result is exactly at the cap", async () => {
    const r = await adapter.query("select * from range(10)", { ...LIMITS, maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it("interrupts queries that run past the timeout", async () => {
    const slow = "select count(*) from range(1000000000) a, range(1000) b";
    await expect(adapter.query(slow, { ...LIMITS, timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" });
    // The connection must still work afterwards.
    await expect(adapter.query("select 1 as ok", LIMITS)).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});

describe("guards", () => {
  const refused = async (sql: string, code: string) => {
    const err = await adapter.query(sql, LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardError);
    expect((err as GuardError).code).toBe(code);
  };

  it.each([
    ["insert into teams values (9, 'X', 'X')"],
    ["update teams set name = 'X'"],
    ["delete from teams"],
    ["create table x (a int)"],
    ["drop table teams"],
    ["set enable_external_access = true"],
    ["attach '/tmp/other.duckdb' as other"],
    ["install httpfs"],
    ["load httpfs"],
  ])("refuses non-SELECT statement: %s", async (sql) => refused(sql, "statement_not_allowed"));

  it("refuses stacked statements even when the first is a SELECT", async () => {
    await refused("select 1; drop table teams", "multiple_statements");
  });

  it("refuses empty input", async () => {
    await refused("   ", "empty_query");
    await refused("-- just a comment", "empty_query");
    await refused(";", "empty_query");
  });

  it("passes real syntax errors through so the model sees the parser hint", async () => {
    const err = await adapter.query("selec 1", LIMITS).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GuardError);
    expect(String((err as Error).message)).toMatch(/Parser Error/);
  });

  // SELECTs pass the statement check, and COPY/EXPORT fail while binding (before the type is known),
  // so for all of these it is the engine sandbox that has to say no.
  it.each([
    ["copy teams to '/tmp/out.csv'"],
    ["export database '/tmp/exp'"],
    ["select * from read_csv('/etc/passwd')"],
    ["select * from read_text('/etc/hosts')"],
    ["select * from 'https://example.com/data.csv'"],
    ["select * from glob('/Users/*')"],
  ])("engine sandbox blocks file/network access: %s", async (sql) => {
    const err = await adapter.query(sql, LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GuardError);
    expect(String((err as Error).message)).toMatch(/disabled by configuration|Permission Error|not.*(loaded|found)/i);
  });

  it("leaves the data untouched after all of the above", async () => {
    const r = await adapter.query("select count(*)::int as n from teams", LIMITS);
    expect(r.rows).toEqual([{ n: 3 }]);
  });
});
