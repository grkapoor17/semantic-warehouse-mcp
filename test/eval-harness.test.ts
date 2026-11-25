/**
 * The eval harness, end to end, with FAKE model clients: scripted responses stand in for the API,
 * but the loop code, the MCP server, DuckDB and the scorer are all real. No network, no cost.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openArm, type Arm } from "../eval/harness/arms.js";
import { requestCost } from "../eval/harness/pricing.js";
import { AnthropicProvider } from "../eval/harness/providers/anthropic.js";
import { OpenAIProvider } from "../eval/harness/providers/openai.js";
import { BUDGET_EXHAUSTED } from "../eval/harness/types.js";
import { summarise } from "../eval/report.js";
import type { RunResult } from "../eval/run.js";
import { ANSWER_FORMAT, scoreAnswer, type GoldQuestion } from "../eval/score.js";
import { makeShopDb, shopManifest } from "./semantic-fixture.js";

let db: { path: string; cleanup: () => void };
const arms: Partial<Record<"A" | "B" | "C", Arm>> = {};

beforeAll(async () => {
  db = await makeShopDb("marts"); // the arms only allow schema "marts"
  for (const id of ["A", "B", "C"] as const) arms[id] = await openArm(id, { db: db.path, manifestJson: marts(shopManifest) });
});
afterAll(async () => {
  for (const a of Object.values(arms)) await a?.close();
  db.cleanup();
});

/** Point the shop manifest at schema "marts", where this test's fixture puts the tables. */
function marts(m: typeof shopManifest): typeof shopManifest {
  return JSON.parse(JSON.stringify(m).replaceAll('"schema_name":"shop"', '"schema_name":"marts"'));
}

describe("arms", () => {
  it("A has only SQL tools; B and C add the semantic tools", () => {
    expect(arms.A!.tools.map((t) => t.name).sort()).toEqual(["describe_table", "list_tables", "run_query"]);
    for (const id of ["B", "C"] as const) expect(arms[id]!.tools).toHaveLength(6);
  });

  it("system prompts differ only by server instructions (B, C) and the skill (C)", () => {
    for (const a of Object.values(arms)) expect(a!.system).toContain(ANSWER_FORMAT);
    expect(arms.A!.system).not.toContain("semantic layer");
    expect(arms.B!.system).toContain("Instructions from the warehouse server");
    expect(arms.B!.system).not.toContain("# Skill: warehouse-analysis");
    expect(arms.C!.system).toContain("# Skill: warehouse-analysis");
    expect(arms.C!.system).toContain("query-patterns.md");
    expect(arms.C!.system).not.toMatch(/^---\nname:/m); // frontmatter stripped
  });
});

// ------------------------------------------------------------------------------------------------
// Claude loop with a fake client

type Fake = Partial<Anthropic.Message> & { content: Anthropic.ContentBlock[]; stop_reason: Anthropic.Message["stop_reason"] };
const usage = (i = 1000, o = 200, read = 0, write = 0) =>
  ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: read, cache_creation_input_tokens: write }) as Anthropic.Usage;
const thinking = { type: "thinking", thinking: "", signature: "sig" } as unknown as Anthropic.ContentBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;

function fakeAnthropic(script: (params: Anthropic.MessageCreateParams, turn: number) => Fake) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        return { usage: usage(), ...script(params, calls.length - 1) };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("Claude loop", () => {
  it("runs tools against the real server, keeps thinking blocks, and scores the answer", async () => {
    const { client, calls } = fakeAnthropic((_, turn) =>
      turn === 0
        ? { content: [thinking, toolUse("t1", "query_metrics", { metrics: ["revenue"] })], stop_reason: "tool_use", usage: usage(1000, 100, 0, 3000) }
        : { content: [thinking, text("Revenue was 200.\nANSWER: 200")], stop_reason: "end_turn", usage: usage(50, 80, 3000, 400) },
    );
    const run = await new AnthropicProvider(client).run({
      model: "claude-opus-5-5", system: arms.B!.system, question: "Total revenue?", tools: arms.B!.tools, callTool: arms.B!.callTool, maxToolCalls: 15,
    });

    expect(run.stopReason).toBe("end_turn");
    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0]!.preview).toContain('"revenue": 200'); // the real compiler + DuckDB answered
    // Second request carries the first response unchanged (thinking included) and the tool result.
    const second = calls[1]!.messages;
    expect(second[1]).toEqual({ role: "assistant", content: [thinking, toolUse("t1", "query_metrics", { metrics: ["revenue"] })] });
    expect((second[2]!.content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    // Settings the eval depends on.
    expect(calls[0]).toMatchObject({ output_config: { effort: "medium" }, cache_control: { type: "ephemeral" } });
    expect(calls[0]).not.toHaveProperty("fallbacks");
    // Usage and cost add up per request.
    expect(run.usage).toEqual({ inputTokens: 1050, outputTokens: 180, cacheReadTokens: 3000, cacheWriteTokens: 3400 });
    const expected =
      requestCost("claude-opus-5-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 3000 }) +
      requestCost("claude-opus-5-5", { inputTokens: 50, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 400 });
    expect(run.costUsd).toBeCloseTo(expected, 10);

    const gold = { id: "x", question: "", answer_type: "number", answer: 200, tags: [] } as GoldQuestion;
    expect(scoreAnswer(gold, run.finalText).correct).toBe(true);
  });

  it("enforces the tool budget: refuses extra calls, then makes the model answer without tools", async () => {
    const { client, calls } = fakeAnthropic((params) =>
      params.tool_choice?.type === "none"
        ? { content: [text("ANSWER: 1")], stop_reason: "end_turn" }
        : { content: [toolUse(`a${Math.random()}`, "list_tables", {}), toolUse(`b${Math.random()}`, "list_tables", {})], stop_reason: "tool_use" },
    );
    const run = await new AnthropicProvider(client).run({
      model: "claude-haiku-5-5", system: "s", question: "q", tools: arms.A!.tools, callTool: arms.A!.callTool, maxToolCalls: 3,
    });
    expect(run.toolCalls).toHaveLength(3); // the 4th parallel call was refused, not run
    expect(run.stopReason).toBe("end_turn_after_budget");
    const last = calls.at(-1)!;
    expect(last.tool_choice).toEqual({ type: "none" });
    const lastUser = last.messages.at(-1)!.content as Anthropic.ContentBlockParam[];
    expect(lastUser.some((b) => b.type === "tool_result" && b.is_error && b.content === BUDGET_EXHAUSTED)).toBe(true);
    expect(lastUser.some((b) => b.type === "text" && b.text === BUDGET_EXHAUSTED)).toBe(true);
  });

  it("records refusals and API errors instead of crashing", async () => {
    const refusal = fakeAnthropic(() => ({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "" } } as unknown as Fake));
    const r1 = await new AnthropicProvider(refusal.client).run({ model: "claude-opus-5-5", system: "s", question: "q", tools: [], callTool: arms.A!.callTool, maxToolCalls: 5 });
    expect(r1.stopReason).toBe("refusal:cyber");

    const broken = { messages: { create: async () => { throw new Error("network down"); } } } as unknown as Anthropic;
    const r2 = await new AnthropicProvider(broken).run({ model: "claude-opus-5-5", system: "s", question: "q", tools: [], callTool: arms.A!.callTool, maxToolCalls: 5 });
    expect(r2).toMatchObject({ stopReason: "error", error: "Error: network down" });
  });
});

// ------------------------------------------------------------------------------------------------
// OpenAI loop with a fake client

describe("OpenAI loop", () => {
  it("runs function calls, feeds outputs back, and counts cached tokens", async () => {
    const calls: OpenAI.Responses.ResponseCreateParams[] = [];
    const client = {
      responses: {
        create: async (params: OpenAI.Responses.ResponseCreateParams) => {
          calls.push(structuredClone(params));
          const first = calls.length === 1;
          return {
            status: "completed",
            usage: { input_tokens: 2000, output_tokens: 100, input_tokens_details: { cached_tokens: first ? 0 : 1500 } },
            output: first
              ? [{ type: "function_call", call_id: "c1", name: "run_query", arguments: '{"sql":"select count(*) as n from marts.orders"}' }]
              : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ANSWER: 4" }] }],
            output_text: first ? "" : "ANSWER: 4",
          };
        },
      },
    } as unknown as OpenAI;
    const run = await new OpenAIProvider(client).run({
      model: "gpt-6.2-sol", system: arms.A!.system, question: "How many orders?", tools: arms.A!.tools, callTool: arms.A!.callTool, maxToolCalls: 15,
    });
    expect(run).toMatchObject({ stopReason: "end_turn", finalText: "ANSWER: 4", turns: 2 });
    expect(run.toolCalls[0]).toMatchObject({ name: "run_query", isError: false });
    expect(run.toolCalls[0]!.preview).toContain('"n": 4');
    const fed = calls[1]!.input as OpenAI.Responses.ResponseInputItem[];
    expect(fed.at(-1)).toMatchObject({ type: "function_call_output", call_id: "c1" });
    expect(calls[0]).toMatchObject({ instructions: arms.A!.system, tool_choice: "auto" });
    expect(run.usage).toEqual({ inputTokens: 2500, outputTokens: 200, cacheReadTokens: 1500, cacheWriteTokens: 0 });
  });
});

// ------------------------------------------------------------------------------------------------

describe("report", () => {
  it("summarises accuracy by model x arm and by trap", () => {
    const r = (model: string, arm: "A" | "B", qid: string, correct: boolean): RunResult => ({
      key: `${model}|${arm}|${qid}|1`, model, arm, qid, repeat: 1, correct, reason: "", formatError: false, stopReason: "end_turn",
      toolCalls: 2, toolErrors: 0, toolsUsed: {}, turns: 3, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.01, latencyMs: 1000, answerLine: null,
    });
    const gold = [
      { id: "q1", tags: ["warmup"] },
      { id: "q2", tags: ["own_goals"] },
    ] as GoldQuestion[];
    const out = summarise([r("m", "A", "q1", true), r("m", "A", "q2", false), r("m", "B", "q1", true), r("m", "B", "q2", true)], gold);
    expect(out).toContain("| m | 50% (1/2) | 100% (2/2) |");
    expect(out).toContain("| own_goals | 1 | 0% | 100% |");
    expect(out).toContain("Total: 4 runs, $0.04.");
  });
});
