/**
 * Gemini agent loop (@google/genai, function calling), shaped like the Claude and OpenAI loops:
 * same tools, system prompt, tool budget and budget message. Thinking is left at the model default,
 * as in receipt-bench, and thinking tokens are billed as output.
 *
 * Each model turn's `content` is appended unchanged, so any thought signatures Gemini attaches to
 * function calls are sent back as required.
 */
import { ApiError, FunctionCallingConfigMode, GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import { requestCost } from "../pricing.js";
import { BUDGET_EXHAUSTED, emptyUsage, type AgentInput, type AgentRun, type Provider, type ToolCallRecord } from "../types.js";

const MAX_OUTPUT_TOKENS = 16_000;
const MAX_TURNS = 40;

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  constructor(private readonly client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })) {}

  async run({ model, system, question, tools, callTool, maxToolCalls }: AgentInput): Promise<AgentRun> {
    const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }));
    const contents: Content[] = [{ role: "user", parts: [{ text: question }] }];
    const usage = emptyUsage();
    const toolCalls: ToolCallRecord[] = [];
    let costUsd = 0;
    let turns = 0;
    let finalText = "";
    let stopReason = "unknown";
    let budgetSpent = false;

    try {
      while (turns < MAX_TURNS) {
        const response = await this.client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations }],
            toolConfig: { functionCallingConfig: { mode: budgetSpent ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO } },
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        });
        turns++;
        const m = response.usageMetadata;
        const cached = m?.cachedContentTokenCount ?? 0;
        const u = {
          inputTokens: (m?.promptTokenCount ?? 0) - cached,
          outputTokens: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0),
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        };
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        costUsd += requestCost(model, u);

        const candidate = response.candidates?.[0];
        const content = candidate?.content;
        if (content) contents.push({ role: "model", parts: content.parts ?? [] });
        finalText = (content?.parts ?? [])
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join("");
        const finish = String(candidate?.finishReason ?? "none");
        const calls: FunctionCall[] = response.functionCalls ?? [];

        if (calls.length === 0) {
          stopReason = finish === "STOP" ? (budgetSpent ? "end_turn_after_budget" : "end_turn") : `finish:${finish}`;
          break;
        }

        const parts: Part[] = [];
        for (const call of calls) {
          const name = call.name ?? "";
          if (toolCalls.length >= maxToolCalls) {
            parts.push({ functionResponse: { id: call.id, name, response: { error: BUDGET_EXHAUSTED } } });
            continue;
          }
          const started = Date.now();
          const r = await callTool(name, call.args ?? {});
          toolCalls.push({ name, input: call.args ?? {}, isError: r.isError, ms: Date.now() - started, preview: r.text.slice(0, 500) });
          parts.push({ functionResponse: { id: call.id, name, response: r.isError ? { error: r.text } : { output: r.text } } });
        }
        if (toolCalls.length >= maxToolCalls && !budgetSpent) {
          budgetSpent = true;
          parts.push({ text: BUDGET_EXHAUSTED });
        }
        contents.push({ role: "user", parts });
      }
      if (turns >= MAX_TURNS) stopReason = "max_turns";
      return { finalText, toolCalls, usage, costUsd, turns, stopReason, transcript: contents };
    } catch (err) {
      const error = err instanceof ApiError ? `ApiError ${err.status}: ${err.message}` : String(err);
      return { finalText, toolCalls, usage, costUsd, turns, stopReason: "error", error, transcript: contents };
    }
  }
}
