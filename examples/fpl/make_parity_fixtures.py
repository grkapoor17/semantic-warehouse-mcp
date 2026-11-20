"""Ask MetricFlow (dbt's reference engine) every case in test/fixtures/fpl-parity-cases.json and save
its answers to test/fixtures/fpl-parity-expected.json. The TypeScript compiler must reproduce them.

    cd examples/fpl && DBT_PROFILES_DIR=. .venv/bin/python make_parity_fixtures.py
"""

import csv
import json
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = HERE.parent.parent / "test" / "fixtures" / "fpl-parity-cases.json"
OUT = CASES.with_name("fpl-parity-expected.json")


def lit(v):
    return "'" + str(v).replace("'", "''") + "'" if isinstance(v, str) else str(v)


def where_clause(f):
    col = "{{ Dimension('%s') }}" % f["field"]
    if f["op"] in ("in", "not in"):
        return f"{col} {f['op']} ({', '.join(lit(v) for v in f['value'])})"
    if f["op"] in ("is null", "is not null"):
        return f"{col} {f['op']}"
    return f"{col} {f['op']} {lit(f['value'])}"


def mf_args(q):
    args = ["--metrics", ",".join(q["metrics"])]
    if q.get("group_by"):
        args += ["--group-by", ",".join(q["group_by"])]
    if q.get("where"):
        args += ["--where", " and ".join(where_clause(f) for f in q["where"])]
    if q.get("order_by"):
        args += ["--order", ",".join(("-" if o.get("descending") else "") + o["field"] for o in q["order_by"])]
    if q.get("limit"):
        args += ["--limit", str(q["limit"])]
    return args


def cell(v):
    if v == "":
        return None
    for cast in (int, float):
        try:
            return cast(v)
        except ValueError:
            pass
    return v


def main():
    results = []
    for case in json.loads(CASES.read_text()):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "out.csv"
            subprocess.run([str(HERE / ".venv/bin/mf"), "query", *mf_args(case["query"]), "--csv", str(out)],
                           cwd=HERE, check=True, capture_output=True)
            with out.open() as f:
                rows = [{k: cell(v) for k, v in r.items()} for r in csv.DictReader(f)]
        print(f"{len(rows):3} rows  {case['name']}")
        results.append({"name": case["name"], "rows": rows})
    OUT.write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
