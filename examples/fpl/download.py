"""Download FPL history from vaastav/Fantasy-Premier-League (MIT) at a pinned commit.

Pinning keeps the warehouse, and therefore the eval's gold answers, reproducible while the
current season keeps updating upstream. Files land in data/raw/ (gitignored, never committed).

    python download.py            # all seasons
    python download.py --force    # re-download even if files exist
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

COMMIT = "d7b05b51d137bfefef4b692386d18c610975b9b9"  # 2026-10-22
BASE = f"https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/{COMMIT}/data"
SEASONS = [f"{y}-{(y + 1) % 100:02d}" for y in range(2016, 2027)]  # 2016-17 .. 2026-27

# fixtures.csv / teams.csv only exist from 2019-20; earlier team names come from master_team_list.csv.
PER_SEASON = ["players_raw.csv", "gws/merged_gw.csv"]
FROM_2019 = ["fixtures.csv", "teams.csv"]
TOP_LEVEL = ["master_team_list.csv"]

OUT = Path(__file__).resolve().parent / "data" / "raw"


def files() -> list[str]:
    out = list(TOP_LEVEL)
    for s in SEASONS:
        out += [f"{s}/{f}" for f in PER_SEASON]
        if s >= "2019-20":
            out += [f"{s}/{f}" for f in FROM_2019]
    return out


def fetch(rel: str, force: bool) -> str:
    dest = OUT / rel
    if dest.exists() and not force:
        return f"skip  {rel}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"{BASE}/{rel}", timeout=60) as r:
        data = r.read()
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return f"got   {rel} ({len(data) / 1e6:.1f} MB)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    with ThreadPoolExecutor(max_workers=8) as pool:
        for line in pool.map(lambda f: fetch(f, args.force), files()):
            print(line)
    print(f"done: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
