/**
 * Claude agent loop (Anthropic Messages API, manual tool-use loop).
 *
 * Manual rather than the SDK's beta Tool Runner because the eval needs a hard tool-call budget,
 * per-request usage and cost, and the same loop shape as the OpenAI provider.
 *
 * Eval-specific choices:
 *   - effort is pinned to "medium" (the default for both Opus 5.5 and Haiku 5.5) so a future SDK or
 *     API default change can't silently change the experiment.
 *   - Thinking stays on (adaptive; it can't be disabled on these models). Each response's content is
 *     appended unchanged, thinking blocks included, so the history stays append-only.
 *   - No server-side refusal fallbacks: a fallback would answer with a different model and
 *     contaminate the comparison. A refusal is recorded as such.
 *   - Prompt caching on (top-level cache_control): the tools + system prefix repeats every turn.
 */
import Anthropic from "@anthropic-ai/sdk";
import { requestCost } from "../pricing.js";
import { BUDGET_EXHAUSTED, emptyUsage, type AgentInput, type AgentRun, type Provider, type ToolCallRecord } from "../types.js";

const MAX_TOKENS = 16_000; // non-streaming default from the API reference
const MAX_TURNS = 40; // backstop; the tool budget normally ends the loop first

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  constructor(private readonly client = new Anthropic()) {}

  async run({ model, system, question, tools, callTool, maxToolCalls }: AgentInput): Promise<AgentRun> {
    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
    const usage = emptyUsage();
    const toolCalls: ToolCallRecord[] = [];
    let costUsd = 0;
    let turns = 0;
    let finalText = "";
    let stopReason = "unknown";
    let budgetSpent = false;

    try {
      while (turns < MAX_TURNS) {
        const response = await this.client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: toolDefs,
          // After the budget is spent, the model must answer instead of calling tools.
          ...(budgetSpent ? { tool_choice: { type: "none" as const } } : {}),
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          messages,
        });
        turns++;
        const u = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        };
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        usage.cacheWriteTokens += u.cacheWriteTokens;
        costUsd += requestCost(model, u);

        messages.push({ role: "assistant", content: response.content });
        finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        stopReason = response.stop_reason ?? "unknown";

        if (response.stop_reason === "refusal") {
          stopReason = `refusal${response.stop_details?.category ? `:${response.stop_details.category}` : ""}`;
          break;
        }
        if (response.stop_reason === "pause_turn") continue;
        if (response.stop_reason !== "tool_use") break; // end_turn, max_tokens, stop_sequence

        const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          // Parallel calls past the budget get a refusal result rather than being dropped.
          if (toolCalls.length >= maxToolCalls) {
            results.push({ type: "tool_result", tool_use_id: use.id, content: BUDGET_EXHAUSTED, is_error: true });
            continue;
          }
          const started = Date.now();
          const r = await callTool(use.name, use.input);
          toolCalls.push({ name: use.name, input: use.input, isError: r.isError, ms: Date.now() - started, preview: r.text.slice(0, 500) });
          results.push({ type: "tool_result", tool_use_id: use.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
        }
        const content: Anthropic.ContentBlockParam[] = [...results];
        if (toolCalls.length >= maxToolCalls && !budgetSpent) {
          budgetSpent = true;
          content.push({ type: "text", text: BUDGET_EXHAUSTED });
        }
        messages.push({ role: "user", content });
      }
      if (turns >= MAX_TURNS) stopReason = "max_turns";
      if (budgetSpent && stopReason === "end_turn") stopReason = "end_turn_after_budget";
      return { finalText, toolCalls, usage, costUsd, turns, stopReason, transcript: messages };
    } catch (err) {
      const error =
        err instanceof Anthropic.APIError ? `${err.constructor.name} ${err.status ?? ""}: ${err.message}` : String(err);
      return { finalText, toolCalls, usage, costUsd, turns, stopReason: "error", error, transcript: messages };
    }
  }
}
