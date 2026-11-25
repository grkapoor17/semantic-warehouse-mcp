"""Compute gold answers for eval/questions.yaml from the local FPL warehouse. No API calls.

    examples/fpl/.venv/bin/python eval/build_gold.py

Writes eval/gold.json and prints a review table. Flags:
  TIE   an entity/ranking question whose cut-off row ties with the next one (the question needs rewording,
        or the answer must become a set)
  NULL  a non-"unavailable" question whose gold value is NULL
"""

from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

import duckdb
import yaml

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "examples/fpl/data/fpl.duckdb"
QUESTIONS = ROOT / "eval/questions.yaml"
OUT = ROOT / "eval/gold.json"


TEAM_ALIASES = {
    "Man Utd": ["Manchester United"], "Man City": ["Manchester City"], "Spurs": ["Tottenham", "Tottenham Hotspur"],
    "Nott'm Forest": ["Nottingham Forest"], "Wolves": ["Wolverhampton", "Wolverhampton Wanderers"],
    "Brighton": ["Brighton & Hove Albion", "Brighton and Hove Albion"], "Newcastle": ["Newcastle United"],
    "West Ham": ["West Ham United"], "Leicester": ["Leicester City"], "Leeds": ["Leeds United"],
}


def fold(s: str) -> str:
    """Lowercase and strip accents, so 'Díaz' == 'diaz'. (ß is folded to 'ss' too.)"""
    s = unicodedata.normalize("NFKD", s.replace("ß", "ss"))
    return "".join(ch for ch in s if not unicodedata.combining(ch)).lower().strip()


def player_names(con, code: int) -> dict:
    full = con.execute("select player_name from marts.dim_players where player_code = ?", [code]).fetchone()[0]
    webs = [r[0] for r in con.execute(
        "select distinct web_name from marts.dim_player_seasons where player_code = ? order by 1", [code]).fetchall()]
    aliases = sorted({fold(n) for n in [full, *webs]})
    return {"player_code": code, "name": full, "aliases": aliases}


def num(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else round(f, 6)


def label(con, row: dict) -> dict:
    if "player_code" in row:
        return {**player_names(con, int(row["player_code"])), "value": num(row.get("value"))}
    if "team_name" in row:
        names = [row["team_name"], *TEAM_ALIASES.get(row["team_name"], [])]
        return {"name": row["team_name"], "aliases": sorted({fold(n) for n in names}), "value": num(row.get("value"))}
    raise ValueError(f"row has neither player_code nor team_name: {row}")


def main() -> int:
    spec = yaml.safe_load(QUESTIONS.read_text())
    con = duckdb.connect(str(DB), read_only=True)
    gold, problems = [], []

    for q in spec["questions"]:
        cur = con.execute(q["gold_sql"])
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        t = q["answer_type"]
        entry = {"id": q["id"], "question": q["question"], "answer_type": t, "path": q["path"], "tags": q["tags"]}
        for k in ("tolerance", "top", "require_value"):
            if k in q:
                entry[k] = q[k]

        if t in ("number", "text", "unavailable"):
            assert len(rows) == 1, f"{q['id']}: expected 1 row, got {len(rows)}"
            v = rows[0]["value"]
            entry["answer"] = num(v) if t != "text" else str(v)
            if t == "unavailable" and v is not None:
                problems.append(f"{q['id']} NOT-NULL: marked unavailable but gold is {v}")
            if t != "unavailable" and v is None:
                problems.append(f"{q['id']} NULL: gold value is NULL")
        elif t in ("entity", "ranking"):
            top = q["top"]
            entry["answer"] = [label(con, r) for r in rows[:top]]
            if len(rows) > top and rows[top - 1]["value"] == rows[top]["value"]:
                tied = label(con, rows[top])
                problems.append(f"{q['id']} TIE at #{top}: {entry['answer'][-1]['name']} = {tied['name']} ({tied['value']})")
        elif t == "set":
            entry["answer"] = [label(con, r) for r in rows]
        elif t == "table":
            entry["answer"] = {str(r["key"]): num(r["value"]) for r in rows}
        else:
            raise ValueError(f"{q['id']}: unknown answer_type {t}")
        gold.append(entry)

    OUT.write_text(json.dumps({"warehouse": "examples/fpl (vaastav d7b05b5)", "questions": gold}, indent=1, ensure_ascii=False) + "\n")

    for g in gold:
        a = g["answer"]
        if isinstance(a, list):
            shown = "; ".join(f"{x['name']} = {x['value']}" for x in a)
        elif isinstance(a, dict):
            shown = "; ".join(f"{k} = {v}" for k, v in a.items())
        else:
            shown = "NULL (not recorded)" if a is None else str(a)
        print(f"{g['id']}  {g['answer_type']:<11} {shown}")
    print(f"\nwrote {OUT} ({len(gold)} questions)")
    for p in problems:
        print("PROBLEM", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
