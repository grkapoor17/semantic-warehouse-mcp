/** Shapes shared by the providers and the runner. */

/** A tool as the MCP server describes it (name, description, JSON Schema for the input). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  isError: boolean;
  ms: number;
  /** First 500 characters of what the tool returned (full results are in the transcript). */
  preview: string;
}

export interface Usage {
  /** Uncached input tokens, billed at the full input price. */
  inputTokens: number;
  /** Output tokens, including thinking/reasoning. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRun {
  finalText: string;
  toolCalls: ToolCallRecord[];
  usage: Usage;
  /** Summed per request (pricing tiers can depend on each request's prompt size). */
  costUsd: number;
  /** Model turns (API requests) this run took. */
  turns: number;
  /** Why the last turn ended: end_turn, refusal, max_tokens, tool_budget, error... */
  stopReason: string;
  error?: string;
  /** The full conversation in the provider's own format, for debugging and the write-up. */
  transcript: unknown[];
}

export interface AgentInput {
  model: string;
  system: string;
  question: string;
  tools: ToolSpec[];
  callTool: (name: string, input: unknown) => Promise<{ text: string; isError: boolean }>;
  /** Stop offering tools after this many calls; the model then has to answer. */
  maxToolCalls: number;
}

export interface Provider {
  readonly name: string;
  run(input: AgentInput): Promise<AgentRun>;
}

/** Shown to the model when the tool budget runs out. Same wording for every provider. */
export const BUDGET_EXHAUSTED =
  "You have used all your tool calls. Give your final answer now, from what you have found, ending with the ANSWER line.";

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
