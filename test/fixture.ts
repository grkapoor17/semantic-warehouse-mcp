import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/** Builds a small writable DuckDB file, closes it, and returns its path (the adapter then reopens it read-only). */
export async function makeFixtureDb(): Promise<{ path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "swmcp-"));
  const path = join(dir, "fixture.duckdb");
  const db = await DuckDBInstance.create(path);
  const c = await db.connect();
  await c.run(`
    create table teams (team_id int primary key, name varchar not null, short_name varchar);
    comment on table teams is 'One row per Premier League club.';
    insert into teams values (1, 'Arsenal', 'ARS'), (2, 'Liverpool', 'LIV'), (3, 'Spurs', 'TOT');
    create table player_gameweeks as
      select (range % 50) as player_id, (range % 3) + 1 as team_id, (range // 50) + 1 as gw,
             (range * 7) % 13 as total_points
        from range(1000);
    create schema marts;
    create view marts.team_points as
      select t.name, sum(p.total_points) as points
        from player_gameweeks p join teams t using (team_id) group by 1;
  `);
  c.closeSync();
  db.closeSync();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
