# Eval: does a semantic layer help an agent answer warehouse questions correctly?

50 questions over the [FPL example warehouse](../examples/fpl), each with a verified gold answer.
The same questions will be asked in three setups:

| Setup | Tools | Represents |
|---|---|---|
| A. SQL only | `list_tables`, `describe_table`, `run_query` on `marts` | a typical "chat with your warehouse" MCP server |
| B. + semantic layer | A + `list_metrics`, `list_dimensions`, `query_metrics` | this server with a dbt semantic manifest |
| C. + semantic layer + skill | B + [`skills/warehouse-analysis`](../skills/warehouse-analysis/SKILL.md) | the full package |

All setups see the same clean `marts` tables, so the baseline is fair: a SQL agent on a well-documented warehouse.

## Files

| File | What it is |
|---|---|
| [`questions.yaml`](questions.yaml) | The 50 questions, answer types, gold SQL, trap tags, and a one-line "why" for each |
| [`build_gold.py`](build_gold.py) | Runs the gold SQL against the local warehouse, writes `gold.json`, flags ties and NULLs |
| [`gold.json`](gold.json) | Gold answers with name aliases for matching |
| [`crosscheck_mf.py`](crosscheck_mf.py) | Recomputes 14 gold answers through MetricFlow (dbt's engine): 14/14 agree |
| [`score.ts`](score.ts) | Grades an agent's `ANSWER: <json>` line against gold |

## How gold answers are made

Gold answers come from hand-written SQL against `marts`, **never** from this server's metric compiler,
so the eval can't grade the compiler with itself. Gold SQL identifies players by their stable
`player_code`, so it can't fall into the name traps the questions test. 14 answers are cross-checked
against MetricFlow, and the well-known ones match real-world records (e.g. 1,246 goals in 2023-24).

## The traps

| Tag | Example |
|---|---|
| `cross_season`, `unstable_names` | Grouping by display name splits Salah's 2,208 points into "Salah" + "M.Salah" |
| `name_mismatch` | "Pascal Gross" is "Groß" in the data; "Man United" is "Man Utd" |
| `ambiguous_match`, `ambiguous_person` | "salah" also matches Salah-Eddine; there are two Danny Wards |
| `team_vs_player`, `own_goals` | Arsenal's players scored 85 in 2023-24; the club scored 91 |
| `grain`, `double_gameweek`, `blank_gameweek` | Salah's GW24 2024-25 is two matches (29 pts) |
| `transfers` | Van Dijk scored 53 *for Liverpool* in 2017-18, not his 78 season total |
| `managers` | Manager David Moyes would rank 2nd in Everton's 2024-25 points |
| `small_sample`, `precision` | With no minimum, a 1-minute player "leads" points per 90 |
| `missing_data`, `knowledge_vs_data` | Kane's 2020-21 xG isn't recorded; his 2023-24 points are 0 |
| `ties` | Raya and Sels both kept 13 clean sheets in 2024-25 |

## Grading

Every agent gets the same answer instructions (`ANSWER_FORMAT` in `score.ts`), with no hint about the
expected type, and ends with `ANSWER: <json>`. Rules:

- **Numbers:** integers exact; rates within 0.01 (rounding to 2 decimals is fine).
- **Names:** accent- and nickname-tolerant ("Ben White" = "Benjamin White", "Pascal Gross" = "Pascal Groß"),
  but never across people ("Salah-Eddine" is not Mohamed Salah).
- **Rankings:** the top N in the right order. **Ties:** every tied name, no extras.
- **Two people, one name:** both values reported separately. A single summed number is wrong.
- **Missing data:** `null` (or saying it isn't recorded). 0 or a remembered real-world figure is wrong.
- **No parseable ANSWER line:** counted as a format error, separately from wrong answers.

`npm test` checks that every gold answer grades as correct and that the trap answers grade as wrong.
