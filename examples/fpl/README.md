# Example warehouse: Fantasy Premier League, 2016-17 to 2026-27

A small but realistic warehouse for trying the server and for the text-to-SQL eval: about 258k
player-fixture rows over 11 seasons, built with dbt on DuckDB, with a MetricFlow semantic layer.

```bash
./build.sh        # creates .venv, downloads data, runs dbt build -> fpl.duckdb
claude mcp add fpl -- node ../../dist/cli.js --duckdb "$(pwd)/fpl.duckdb"
```

Data: [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) (MIT),
pinned to commit `d7b05b5` (2026-10-22) so results are reproducible. It is downloaded, never committed.

## Layers

| Schema | Tables | What it is |
|---|---|---|
| `raw` | raw_gameweeks, raw_players, raw_teams | CSVs as published, unioned across seasons |
| `staging` | stg_player_fixtures, stg_players, stg_teams | Typed, de-duplicated, ids resolved |
| `marts` | fct_player_fixtures, fct_fixtures, dim_players, dim_player_seasons, dim_teams | What agents should query |

The semantic layer (`models/marts/_semantic.yml`) defines 5 semantic models and 26 metrics
(`total_points`, `points_per_90`, `goals_minus_xg`, `points_per_million`, `goals_per_match`, ...).
`dbt parse` compiles it to `target/semantic_manifest.json`. You can query it directly with
MetricFlow: `DBT_PROFILES_DIR=. .venv/bin/mf query --metrics total_points --group-by player__player_name --order -total_points --limit 5`.

## Why this dataset is a good test

These are real data problems, and they are what a semantic layer should fix:

- **Ids change every season.** FPL's player `id` and team `id` are reassigned every season (Salah is 234, 253, 191, ...).
  The stable keys are `player_code` and `team_code`. Id 328 belongs to 11 different players across seasons.
- **Display names aren't stable or unique.** Salah is "Salah" until 2023-24 and "M.Salah" after, so grouping by
  `web_name` splits his 2,208 career points into 1,741 + 467. Two different "Palacios" play in 2026-27.
- **Gameweeks aren't fixtures.** Double gameweeks (up to 2,217 player-rounds in 2021-22) and blanks
  (2022-23 has 37 gameweeks; GW7 was postponed) mean "points in GW N" must sum over fixtures.
- **2019-20 rounds were renumbered.** After the COVID pause FPL published GW 30-38 as rounds 39-47 (normalised here).
- **Mid-season transfers.** Seasons before 2020-21 don't record a player's club per match. It is derived from the
  fixture's two opponent ids, which matches the published club on all ~167k rows where both exist.
- **Managers in the player table.** The 2024-25 "assistant manager" chip lists 20 real managers as FPL elements (position `MGR`).
- **Columns appear over time.** xG/xA/starts exist from 2022-23 and defensive contribution from 2025-26; earlier values are NULL.

## Known data caveats

- Evan Ferguson 2024-25: fixture points sum to 27 vs FPL's official 28 (upstream; the reconcile test warns on it).
- 2026-27 covers GW 1-6 only (the pinned snapshot), and FPL's live season totals can lead the fixture rows by a few points.
- Old files are Latin-1, newer ones UTF-8; `raw_*` handles both.
