/**
 * The three setups ("arms") under test, each a real in-process instance of the MCP server.
 *
 *   A  SQL tools only            list_tables, describe_table, run_query
 *   B  + semantic layer          A + list_metrics, list_dimensions, query_metrics (+ server instructions)
 *   C  + semantic layer + skill  B + the warehouse-analysis Agent Skill in the system prompt
 *
 * Every arm sees the same warehouse, limited to the curated `marts` schema.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DuckDBAdapter } from "../../src/adapters/duckdb.js";
import { createServer, DEFAULT_LIMITS } from "../../src/server.js";
import type { SemanticManifest } from "../../src/semantic/manifest.js";
import { ANSWER_FORMAT } from "../score.js";
import type { ToolSpec } from "./types.js";

export type ArmId = "A" | "B" | "C";
export const ARMS: Record<ArmId, { label: string; semantic: boolean; skill: boolean }> = {
  A: { label: "SQL tools only", semantic: false, skill: false },
  B: { label: "+ semantic layer", semantic: true, skill: false },
  C: { label: "+ semantic layer + skill", semantic: true, skill: true },
};

export const PATHS = {
  db: "examples/fpl/data/fpl.duckdb",
  manifest: "examples/fpl/target/semantic_manifest.json",
  skill: "skills/warehouse-analysis/SKILL.md",
  skillPatterns: "skills/warehouse-analysis/references/query-patterns.md",
};

const BASE_SYSTEM = `You answer questions about Fantasy Premier League (FPL) data using the tools of a read-only data warehouse.
The warehouse covers the 2016-17 to 2025-26 seasons plus gameweeks 1-6 of 2026-27.
Answer from the data only: if your memory of real-world events disagrees with the data, the data wins.
You are running unattended, so you can't ask the user anything. If a question is ambiguous, answer every reasonable reading.`;

export interface Arm {
  id: ArmId;
  system: string;
  tools: ToolSpec[];
  callTool: (name: string, input: unknown) => Promise<{ text: string; isError: boolean }>;
  close: () => Promise<void>;
}

/** Start the MCP server for an arm and connect an in-memory client to it. */
export async function openArm(id: ArmId, opts: { db?: string; manifest?: string; manifestJson?: SemanticManifest } = {}): Promise<Arm> {
  const spec = ARMS[id];
  const adapter = await DuckDBAdapter.open(opts.db ?? PATHS.db, { allowedSchemas: ["marts"] });
  const semanticManifest = spec.semantic
    ? (opts.manifestJson ?? (JSON.parse(readFileSync(opts.manifest ?? PATHS.manifest, "utf8")) as SemanticManifest))
    : undefined;
  const server = createServer({ adapter, semanticManifest, limits: DEFAULT_LIMITS });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval-harness", version: "0.1.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const tools: ToolSpec[] = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  // What an MCP client like Claude Code puts in front of the model: our base prompt, the server's
  // own instructions (sent only when a semantic layer is loaded), and for arm C the skill.
  const parts = [BASE_SYSTEM];
  const instructions = client.getInstructions();
  if (instructions) parts.push(`Instructions from the warehouse server:\n${instructions}`);
  if (spec.skill) {
    const skill = readFileSync(PATHS.skill, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const patterns = readFileSync(PATHS.skillPatterns, "utf8");
    parts.push(`# Skill: warehouse-analysis\n\n${skill}\n\n# Skill reference: references/query-patterns.md\n\n${patterns}`);
  }
  parts.push(ANSWER_FORMAT);

  return {
    id,
    system: parts.join("\n\n"),
    tools,
    callTool: async (name, input) => {
      const r = await client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
      const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      return { text, isError: Boolean(r.isError) };
    },
    close: async () => {
      await client.close();
      await adapter.close();
    },
  };
}
