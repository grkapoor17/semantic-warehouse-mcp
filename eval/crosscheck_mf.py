"""Cross-check gold answers against MetricFlow (dbt's metric engine): a second, independent route to
the same number. Local only, no API calls.

    examples/fpl/.venv/bin/python eval/crosscheck_mf.py
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FPL = ROOT / "examples/fpl"
GOLD = {g["id"]: g for g in json.loads((ROOT / "eval/gold.json").read_text())["questions"]}

D = lambda name: "{{ Dimension('%s') }}" % name  # noqa: E731
SEASON, PLAYER, GW = D("player_fixture__season"), D("player__player_name"), D("player_fixture__gameweek")
TEAM, POS = D("player_fixture__team_name"), D("player_fixture__position")

# id -> (mf args, how to read the answer from MetricFlow's rows)
CASES = {
    "q01": (["--metrics", "total_points", "--where", f"{SEASON} = '2024-25' and {PLAYER} = 'Mohamed Salah'"], "scalar"),
    "q03": (["--metrics", "match_goals", "--where", f"{D('fixture__match_season')} = '2023-24'"], "scalar"),
    "q04": (["--metrics", "goals_per_match", "--where", f"{D('fixture__match_season')} = '2018-19'"], "scalar"),
    "q12": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Mohamed Salah'"], "scalar"),
    "q13": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Bruno Borges Fernandes'"], "scalar"),
    "q25": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Mohamed Salah' and {SEASON} = '2024-25' and {GW} = 24"], "scalar"),
    "q35": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Virgil van Dijk' and {SEASON} = '2017-18' and {TEAM} = 'Liverpool'"], "scalar"),
    "q37": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Antoine Semenyo' and {SEASON} = '2025-26' and {TEAM} = 'Man City'"], "scalar"),
    "q40": (["--metrics", "total_points", "--where", f"{SEASON} = '2024-25' and {POS} != 'MGR'"], "scalar"),
    "q45": (["--metrics", "expected_goals", "--where", f"{PLAYER} = 'Harry Kane' and {SEASON} = '2020-21'"], "scalar"),
    "q47": (["--metrics", "total_points", "--where", f"{PLAYER} = 'Harry Kane' and {SEASON} = '2023-24'"], "scalar"),
    "q39": (["--metrics", "total_points", "--group-by", "player__player_name",
             "--where", f"{SEASON} = '2024-25' and {TEAM} = 'Everton' and {POS} != 'MGR'",
             "--order", "-total_points", "--limit", "3"], "names"),
    "q43": (["--metrics", "points_per_appearance", "--group-by", "player_fixture__was_home",
             "--where", f"{PLAYER} = 'Mohamed Salah'"], "home_away"),
    "q48": (["--metrics", "clean_sheets", "--group-by", "player__player_name",
             "--where", f"{SEASON} = '2024-25' and {POS} = 'GKP'", "--order", "-clean_sheets", "--limit", "2"], "names"),
}


def mf(args: list[str]) -> list[dict]:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out.csv"
        subprocess.run([str(FPL / ".venv/bin/mf"), "query", *args, "--csv", str(out)], cwd=FPL, check=True,
                       capture_output=True, env={"DBT_PROFILES_DIR": ".", "PATH": "/usr/bin:/bin"})
        with out.open() as f:
            return list(csv.DictReader(f))


def close(a, b, tol=0.01) -> bool:
    if a in ("", None) or b is None:
        return a in ("", None) and b is None
    return abs(float(a) - float(b)) <= tol


def main() -> int:
    bad = 0
    for qid, (args, kind) in CASES.items():
        rows, gold = mf(args), GOLD[qid]["answer"]
        if kind == "scalar":
            got = next(iter(rows[0].values())) if rows else None
            ok = close(got, gold)
        elif kind == "names":
            got = [r["player__player_name"] for r in rows]
            want = [g["name"] for g in gold]
            # set questions (ties) don't care about order
            ok = sorted(got) == sorted(want) if GOLD[qid]["answer_type"] == "set" else got == want
        else:  # home_away
            got = {("home" if r["player_fixture__was_home"] == "True" else "away"): float(r["points_per_appearance"]) for r in rows}
            ok = all(close(got[k], v) for k, v in gold.items())
        bad += not ok
        print(f"{'OK  ' if ok else 'DIFF'} {qid}  gold={gold if not isinstance(gold, list) else [g['name'] for g in gold]}  metricflow={got}")
    print(f"\n{len(CASES) - bad}/{len(CASES)} agree")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
