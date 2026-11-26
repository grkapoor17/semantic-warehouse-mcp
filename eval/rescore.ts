/**
 * Re-grade a finished run with the current scorer and gold answers, from the saved transcripts.
 * No API calls: use it after fixing a grading rule.
 *
 *   npx tsx eval/rescore.ts eval/runs/<dir>
 *
 * Rewrites <dir>/results.jsonl in place (the previous file is kept as results.before-rescore.jsonl)
 * and prints every run whose verdict changed.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreAnswer, type GoldQuestion } from "./score.js";
import type { RunResult } from "./run.js";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npx tsx eval/rescore.ts eval/runs/<dir>");
  process.exit(1);
}
const gold = new Map((JSON.parse(readFileSync("eval/gold.json", "utf8")).questions as GoldQuestion[]).map((q) => [q.id, q]));
const path = join(dir, "results.jsonl");
const results = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunResult);

let changed = 0;
const updated = results.map((r) => {
  const t = JSON.parse(readFileSync(join(dir, "transcripts", `${r.model}__${r.arm}__${r.qid}__r${r.repeat}.json`), "utf8")) as { finalText: string };
  const s = scoreAnswer(gold.get(r.qid)!, t.finalText);
  if (s.correct !== r.correct) {
    changed++;
    console.log(`${r.correct ? "✓→✗" : "✗→✓"} ${r.model} ${r.arm} ${r.qid} r${r.repeat}: ${s.reason}`);
  }
  return { ...r, correct: s.correct, reason: s.reason, formatError: Boolean(s.formatError) };
});
copyFileSync(path, join(dir, "results.before-rescore.jsonl"));
writeFileSync(path, updated.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${changed} verdict(s) changed out of ${results.length}.`);
