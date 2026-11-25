import type { Usage } from "./types.js";

/**
 * USD per 1M tokens. Anthropic rates from the claude-api reference (cached 2026-11-03); OpenAI
 * from receipt-bench's pricing table (checked 2026-11-19). Runs store raw token counts, so cost
 * can be recomputed if a price turns out wrong.
 *
 * cacheRead / cacheWrite: Anthropic bills cache reads at ~0.1x input and writes at ~1.25x.
 * For GPT-6.2 Sol the cached-input discount isn't in our notes, so cached tokens are priced at
 * the full input rate: a deliberate overestimate.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Haiku 5.5 charges more once a single prompt exceeds 100K tokens. */
  longPrompt?: { aboveTokens: number; input: number; output: number };
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5 },
  },
  "gpt-6.2-sol": { input: 2.0, output: 10.0, cacheRead: 2.0, cacheWrite: 2.0 },
};

/** Cost of one API request. `promptTokens` (all input incl. cache) decides the long-prompt tier. */
export function requestCost(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}; add it to eval/harness/pricing.ts`);
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const long = p.longPrompt && promptTokens > p.longPrompt.aboveTokens ? p.longPrompt : null;
  const inRate = long?.input ?? p.input;
  const outRate = long?.output ?? p.output;
  return (
    (u.inputTokens * inRate + u.outputTokens * outRate + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
