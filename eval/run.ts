/**
 * Run the eval: questions x arms x models x repeats.
 *
 *   npx tsx eval/run.ts                                  # plan + cost estimate only (no API calls)
 *   npx tsx eval/run.ts --models haiku --arms A --questions q01,q02 --yes    # a small real run
 *   npx tsx eval/run.ts --yes --max-cost 30              # everything, stop if spend passes $30
 *
 * Nothing calls a model API without --yes. Results append to <out>/results.jsonl, one line per run,
 * and re-running with the same --out skips runs already recorded (so a stopped run can resume).
 * Full conversations go to <out>/transcripts/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ANSWER_FORMAT, scoreAnswer, type GoldQuestion } from "./score.js";
import { ARMS, openArm, type Arm, type ArmId } from "./harness/arms.js";
import { PRICES } from "./harness/pricing.js";
import type { AgentRun, Provider } from "./harness/types.js";

export const MODELS: Record<string, { id: string; provider: "anthropic" | "openai" | "gemini" }> = {
  haiku: { id: "claude-haiku-5-5", provider: "anthropic" },
  terra: { id: "gpt-6.1-terra", provider: "openai" },
  flash: { id: "gemini-3.8-flash", provider: "gemini" },
  // Available, but not in the default lineup (cost):
  opus: { id: "claude-opus-5-5", provider: "anthropic" },
  sol: { id: "gpt-6.2-sol", provider: "openai" },
};

export interface RunResult {
  key: string;
  model: string;
  arm: ArmId;
  qid: string;
  repeat: number;
  correct: boolean;
  reason: string;
  formatError: boolean;
  stopReason: string;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  toolsUsed: Record<string, number>;
  turns: number;
  usage: AgentRun["usage"];
  costUsd: number;
  latencyMs: number;
  answerLine: string | null;
}

const runKey = (model: string, arm: string, qid: string, repeat: number) => `${model}|${arm}|${qid}|${repeat}`;

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: "string", default: "haiku,terra,flash" },
      arms: { type: "string", default: "A,B,C" },
      questions: { type: "string", default: "all" },
      repeats: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      "max-tool-calls": { type: "string", default: "15" },
      "max-cost": { type: "string", default: "40" },
      out: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });

  const models = values.models!.split(",").map((m) => {
    const spec = MODELS[m.trim()];
    if (!spec) throw new Error(`Unknown model "${m}". Use: ${Object.keys(MODELS).join(", ")}`);
    return spec;
  });
  const arms = values.arms!.split(",").map((a) => a.trim() as ArmId);
  for (const a of arms) if (!ARMS[a]) throw new Error(`Unknown arm "${a}". Use A, B, C.`);
  const gold = (JSON.parse(readFileSync("eval/gold.json", "utf8")).questions as GoldQuestion[]).filter(
    (q) => values.questions === "all" || values.questions!.split(",").includes(q.id),
  );
  const repeats = Number(values.repeats);
  const maxToolCalls = Number(values["max-tool-calls"]);
  const maxCost = Number(values["max-cost"]);

  const out = values.out ?? join("eval/runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  const done = new Set<string>();
  const resultsPath = join(out, "results.jsonl");
  let spent = 0;
  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RunResult;
      done.add(r.key);
      spent += r.costUsd;
    }
  }

  const jobs = models.flatMap((m) =>
    arms.flatMap((arm) =>
      gold.flatMap((q) =>
        Array.from({ length: repeats }, (_, i) => ({ model: m, arm, q, repeat: i + 1 })).filter(
          (j) => !done.has(runKey(j.model.id, j.arm, j.q.id, j.repeat)),
        ),
      ),
    ),
  );

  // ---- plan and estimate (always printed; no API calls) --------------------------------------
  const estimate = await estimateCost(jobs.map((j) => ({ model: j.model.id, arm: j.arm })));
  console.log(`Plan: ${models.map((m) => m.id).join(", ")} x arms ${arms.join(",")} x ${gold.length} questions x ${repeats} repeat(s)`);
  console.log(`      ${jobs.length} runs to do${done.size ? ` (${done.size} already in ${resultsPath}, $${spent.toFixed(2)} spent)` : ""}`);
  console.log(`      tool budget ${maxToolCalls} calls/run; stop if total spend passes $${maxCost}`);
  console.log(`Estimated cost: ~$${estimate.likely.toFixed(2)} (range $${estimate.low.toFixed(2)}-$${estimate.high.toFixed(2)})`);
  for (const [m, c] of Object.entries(estimate.byModel)) console.log(`      ${m.padEnd(18)} ~$${c.toFixed(2)}`);
  if (!values.yes) {
    console.log("\nDry run: no API calls made. Add --yes to run.");
    return;
  }

  // ---- real run --------------------------------------------------------------------------------
  if (existsSync(".env")) process.loadEnvFile(".env");
  mkdirSync(join(out, "transcripts"), { recursive: true });
  writeFileSync(join(out, "config.json"), JSON.stringify({ models, arms, questions: gold.map((q) => q.id), repeats, maxToolCalls, maxCost, answerFormat: ANSWER_FORMAT }, null, 2));
  const providers = await loadProviders(models.map((m) => m.provider));

  let next = 0;
  let stopped = false;
  const worker = async () => {
    const opened = new Map<ArmId, Arm>(); // each worker gets its own server + DuckDB connection per arm
    try {
      while (!stopped && next < jobs.length) {
        const j = jobs[next++]!;
        if (spent >= maxCost) {
          stopped = true;
          console.log(`Stopping: spend $${spent.toFixed(2)} reached --max-cost $${maxCost}.`);
          break;
        }
        let arm = opened.get(j.arm);
        if (!arm) {
          arm = await openArm(j.arm);
          opened.set(j.arm, arm);
        }
        const started = Date.now();
        const run = await providers[j.model.provider]!.run({
          model: j.model.id,
          system: arm.system,
          question: j.q.question,
          tools: arm.tools,
          callTool: arm.callTool,
          maxToolCalls,
        });
        const score = scoreAnswer(j.q, run.finalText);
        const result: RunResult = {
          key: runKey(j.model.id, j.arm, j.q.id, j.repeat),
          model: j.model.id,
          arm: j.arm,
          qid: j.q.id,
          repeat: j.repeat,
          correct: score.correct,
          reason: score.reason,
          formatError: Boolean(score.formatError),
          stopReason: run.stopReason,
          error: run.error,
          toolCalls: run.toolCalls.length,
          toolErrors: run.toolCalls.filter((t) => t.isError).length,
          toolsUsed: countBy(run.toolCalls.map((t) => t.name)),
          turns: run.turns,
          usage: run.usage,
          costUsd: run.costUsd,
          latencyMs: Date.now() - started,
          answerLine: /^\s*\**ANSWER\**:\**.*$/im.exec(run.finalText)?.[0]?.trim() ?? null,
        };
        spent += run.costUsd;
        appendFileSync(resultsPath, JSON.stringify(result) + "\n");
        writeFileSync(
          join(out, "transcripts", `${j.model.id}__${j.arm}__${j.q.id}__r${j.repeat}.json`),
          JSON.stringify({ ...result, system: arm.system, question: j.q.question, finalText: run.finalText, toolCalls: run.toolCalls, transcript: run.transcript }, null, 1),
        );
        console.log(
          `${result.correct ? "✓" : "✗"} ${j.model.id.padEnd(17)} ${j.arm} ${j.q.id} r${j.repeat}  ${String(result.toolCalls).padStart(2)} tools  $${run.costUsd.toFixed(4)}  ${(result.latencyMs / 1000).toFixed(1)}s` +
            `${result.correct ? "" : `  (${result.error ?? result.reason})`}`,
        );
      }
    } finally {
      for (const a of opened.values()) await a.close();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  console.log(`\nDone. Spent $${spent.toFixed(2)} in total. Results: ${resultsPath}`);
  console.log(`Summarise with: npx tsx eval/report.ts ${out}`);
}

async function loadProviders(kinds: string[]): Promise<Record<string, Provider>> {
  const out: Record<string, Provider> = {};
  if (kinds.includes("anthropic")) {
    const { AnthropicProvider } = await import("./harness/providers/anthropic.js");
    out.anthropic = new AnthropicProvider();
  }
  if (kinds.includes("openai")) {
    const { OpenAIProvider } = await import("./harness/providers/openai.js");
    out.openai = new OpenAIProvider();
  }
  if (kinds.includes("gemini")) {
    const { GeminiProvider } = await import("./harness/providers/gemini.js");
    out.gemini = new GeminiProvider();
  }
  return out;
}

/**
 * Rough cost estimate with no API calls. The fixed prompt (system + tool definitions) is measured
 * from the real arms (~3.5 characters per token); turns, tool-result size and output per turn are
 * assumptions, given as a low/likely/high range. Anthropic runs assume the repeated prefix is read
 * from cache after the first turn; OpenAI and Gemini runs are priced as if nothing were cached.
 */
export async function estimateCost(jobs: { model: string; arm: ArmId }[]) {
  const fixed: Partial<Record<ArmId, number>> = {};
  for (const arm of new Set(jobs.map((j) => j.arm))) {
    const a = await openArm(arm);
    fixed[arm] = Math.round((a.system.length + JSON.stringify(a.tools).length) / 3.5);
    await a.close();
  }
  const scenarios = {
    low: { turns: 3, resultTokens: 400, outTokens: 300 },
    likely: { turns: 6, resultTokens: 800, outTokens: 600 },
    high: { turns: 12, resultTokens: 1200, outTokens: 1200 },
  };
  const totals = { low: 0, likely: 0, high: 0 } as Record<keyof typeof scenarios, number>;
  const byModel: Record<string, number> = {};
  for (const j of jobs) {
    const p = PRICES[j.model]!;
    const cached = j.model.startsWith("claude");
    for (const [name, s] of Object.entries(scenarios) as [keyof typeof scenarios, (typeof scenarios)["low"]][]) {
      let cost = 0;
      for (let t = 0; t < s.turns; t++) {
        const prefix = fixed[j.arm]! + t * (s.resultTokens + s.outTokens);
        const fresh = t === 0 ? prefix : s.resultTokens + s.outTokens;
        cost += cached
          ? (t === 0 ? fresh * p.cacheWrite : (prefix - fresh) * p.cacheRead + fresh * p.cacheWrite) / 1e6
          : (prefix * p.input) / 1e6;
        cost += (s.outTokens * p.output) / 1e6;
      }
      totals[name] += cost;
      if (name === "likely") byModel[j.model] = (byModel[j.model] ?? 0) + cost;
    }
  }
  return { ...totals, byModel, fixedPromptTokens: fixed };
}

const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
