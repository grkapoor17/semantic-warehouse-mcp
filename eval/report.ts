/**
 * Summarise an eval run: accuracy by model x arm, by trap tag, plus tool calls, cost and failures.
 *
 *   npx tsx eval/report.ts eval/runs/<timestamp>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldQuestion } from "./score.js";
import type { RunResult } from "./run.js";

export function summarise(results: RunResult[], gold: GoldQuestion[]): string {
  const tags = new Map(gold.map((q) => [q.id, q.tags]));
  const models = [...new Set(results.map((r) => r.model))];
  const arms = [...new Set(results.map((r) => r.arm))].sort();
  const pct = (rs: RunResult[]) => (rs.length ? `${((100 * rs.filter((r) => r.correct).length) / rs.length).toFixed(0)}%` : "-");
  const cell = (rs: RunResult[]) => (rs.length ? `${pct(rs)} (${rs.filter((r) => r.correct).length}/${rs.length})` : "-");
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const lines: string[] = [];

  lines.push("## Accuracy by model and setup\n");
  lines.push(`| Model | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
  for (const m of models) lines.push(`| ${m} | ${arms.map((a) => cell(results.filter((r) => r.model === m && r.arm === a))).join(" | ")} |`);

  lines.push("\n## Cost and effort per run (averages)\n");
  lines.push("| Model | Arm | Tool calls | Tool errors | Turns | Cost | Latency | Format errors | API errors |", "|---|---|---|---|---|---|---|---|---|");
  for (const m of models)
    for (const a of arms) {
      const rs = results.filter((r) => r.model === m && r.arm === a);
      if (!rs.length) continue;
      lines.push(
        `| ${m} | ${a} | ${avg(rs.map((r) => r.toolCalls)).toFixed(1)} | ${avg(rs.map((r) => r.toolErrors)).toFixed(1)} | ${avg(rs.map((r) => r.turns)).toFixed(1)} | $${avg(rs.map((r) => r.costUsd)).toFixed(4)} | ${(avg(rs.map((r) => r.latencyMs)) / 1000).toFixed(1)}s | ${rs.filter((r) => r.formatError).length} | ${rs.filter((r) => r.error).length} |`,
      );
    }

  lines.push("\n## Accuracy by trap (all models)\n");
  const allTags = [...new Set(gold.flatMap((q) => q.tags))].sort();
  lines.push(`| Trap | Questions | ${arms.join(" | ")} |`, `|---|---|${arms.map(() => "---").join("|")}|`);
  for (const t of allTags) {
    const rs = results.filter((r) => tags.get(r.qid)?.includes(t));
    if (!rs.length) continue;
    const nq = new Set(rs.map((r) => r.qid)).size;
    lines.push(`| ${t} | ${nq} | ${arms.map((a) => pct(rs.filter((r) => r.arm === a))).join(" | ")} |`);
  }

  const total = results.reduce((s, r) => s + r.costUsd, 0);
  lines.push(`\nTotal: ${results.length} runs, $${total.toFixed(2)}.`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: npx tsx eval/report.ts eval/runs/<timestamp>");
    process.exit(1);
  }
  const results = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunResult);
  const gold = JSON.parse(readFileSync("eval/gold.json", "utf8")).questions as GoldQuestion[];
  console.log(summarise(results, gold));
}
