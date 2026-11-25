/**
 * OpenAI agent loop (Responses API, function tools), shaped like the Claude loop so the arms compare
 * fairly: same tools, system prompt, tool budget and budget message. Reasoning effort is left at
 * the model default, as in receipt-bench.
 */
import OpenAI from "openai";
import { requestCost } from "../pricing.js";
import { BUDGET_EXHAUSTED, emptyUsage, type AgentInput, type AgentRun, type Provider, type ToolCallRecord } from "../types.js";

const MAX_OUTPUT_TOKENS = 16_000;
const MAX_TURNS = 40;

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  constructor(private readonly client = new OpenAI()) {}

  async run({ model, system, question, tools, callTool, maxToolCalls }: AgentInput): Promise<AgentRun> {
    const toolDefs: OpenAI.Responses.FunctionTool[] = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false, // our schemas have optional fields, which strict mode doesn't allow
    }));
    const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: question }];
    const usage = emptyUsage();
    const toolCalls: ToolCallRecord[] = [];
    let costUsd = 0;
    let turns = 0;
    let finalText = "";
    let stopReason = "unknown";
    let budgetSpent = false;

    try {
      while (turns < MAX_TURNS) {
        const response = await this.client.responses.create({
          model,
          instructions: system,
          input,
          tools: toolDefs,
          tool_choice: budgetSpent ? "none" : "auto",
          max_output_tokens: MAX_OUTPUT_TOKENS,
        });
        turns++;
        const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
        const u = {
          inputTokens: (response.usage?.input_tokens ?? 0) - cached,
          outputTokens: response.usage?.output_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        };
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        costUsd += requestCost(model, u);

        // Feed every output item (reasoning, messages, function calls) back, unchanged.
        input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
        finalText = response.output_text ?? "";
        const calls = response.output.filter((i): i is OpenAI.Responses.ResponseFunctionToolCall => i.type === "function_call");

        if (response.status !== "completed") {
          stopReason = `incomplete:${response.incomplete_details?.reason ?? response.status}`;
          break;
        }
        if (calls.length === 0) {
          stopReason = budgetSpent ? "end_turn_after_budget" : "end_turn";
          break;
        }

        for (const call of calls) {
          if (toolCalls.length >= maxToolCalls) {
            input.push({ type: "function_call_output", call_id: call.call_id, output: BUDGET_EXHAUSTED });
            continue;
          }
          let args: unknown;
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch {
            input.push({ type: "function_call_output", call_id: call.call_id, output: "Invalid JSON in tool arguments." });
            toolCalls.push({ name: call.name, input: call.arguments, isError: true, ms: 0, preview: "invalid JSON arguments" });
            continue;
          }
          const started = Date.now();
          const r = await callTool(call.name, args);
          toolCalls.push({ name: call.name, input: args, isError: r.isError, ms: Date.now() - started, preview: r.text.slice(0, 500) });
          input.push({ type: "function_call_output", call_id: call.call_id, output: r.text });
        }
        if (toolCalls.length >= maxToolCalls && !budgetSpent) {
          budgetSpent = true;
          input.push({ role: "user", content: BUDGET_EXHAUSTED });
        }
      }
      if (turns >= MAX_TURNS) stopReason = "max_turns";
      return { finalText, toolCalls, usage, costUsd, turns, stopReason, transcript: input };
    } catch (err) {
      const error = err instanceof OpenAI.APIError ? `${err.constructor.name} ${err.status ?? ""}: ${err.message}` : String(err);
      return { finalText, toolCalls, usage, costUsd, turns, stopReason: "error", error, transcript: input };
    }
  }
}
