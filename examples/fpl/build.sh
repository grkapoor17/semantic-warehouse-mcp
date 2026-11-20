#!/usr/bin/env bash
# Builds examples/fpl/fpl.duckdb: download pinned FPL history, then dbt build (models + 44 tests).
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
.venv/bin/python download.py
rm -f fpl.duckdb
DBT_PROFILES_DIR=. .venv/bin/dbt build
echo "Built $(pwd)/fpl.duckdb"
