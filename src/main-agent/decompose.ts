// =============================================================================
// Eyes-MCP — decompose step
//
// Wraps the heuristic decomposer with an optional LLM call. The main agent
// passes its LLMClient in; if the call fails or no LLM is configured, we
// fall back to the heuristic so the system stays useful without a key.
// =============================================================================

import { z } from "zod";
import { logger as rootLogger } from "../util/logger.js";
import type { LLMClient } from "../llm/client.js";
import { buildDecomposePrompt } from "../llm/prompts.js";
import { ShardSchema, type Shard, type Source } from "../dispatcher/types.js";
import { decomposeHeuristic } from "./decompose-heuristic.js";

/** What the LLM is asked to return. Mirrors Shard[] but in object form. */
const DecomposeOutputSchema = z.object({
  shards: z.array(ShardSchema).min(1),
});
type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

export interface DecomposeOptions {
  /** Optional logger. */
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
}

/**
 * Decompose a research prompt into a list of shards.
 *
 * @param prompt         The research question.
 * @param availableSources  The source categories available to sub-agents.
 * @param maxShards      Cap on returned shards.
 * @param llm            Optional LLM client. If null/undefined, heuristic only.
 * @param options        Misc options.
 */
export async function decompose(
  prompt: string,
  availableSources: ReadonlyArray<Source>,
  maxShards: number,
  llm: LLMClient | null,
  options: DecomposeOptions = {},
): Promise<Shard[]> {
  const log = options.logger ?? rootLogger;
  const cap = Math.max(1, maxShards);

  if (llm && llm.isConfigured) {
    try {
      const shards = await llmDecompose(prompt, availableSources, cap, llm, log);
      if (shards.length > 0) {
        return shards;
      }
      log.warn("decompose: LLM returned no usable shards, falling back to heuristic", {
        prompt: prompt.slice(0, 80),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("decompose: LLM call failed, falling back to heuristic", {
        err: message,
        prompt: prompt.slice(0, 80),
      });
    }
  }

  return decomposeHeuristic(prompt, availableSources, cap);
}

async function llmDecompose(
  prompt: string,
  availableSources: ReadonlyArray<Source>,
  cap: number,
  llm: LLMClient,
  log: DecomposeOptions["logger"],
): Promise<Shard[]> {
  const fullPrompt = buildDecomposePrompt({
    prompt,
    availableSources,
    maxShards: cap,
  });

  const result = await llm.generate(fullPrompt, {
    responseSchema: DecomposeOutputSchema,
    temperature: 0.2,
    maxTokens: 1024,
  });

  // Prefer the structured result; fall back to parsing the raw text.
  let parsed: DecomposeOutput | null = null;
  if (result.structured) {
    const check = DecomposeOutputSchema.safeParse(result.structured);
    if (check.success) parsed = check.data;
  }
  if (!parsed) {
    try {
      const obj = JSON.parse(result.text);
      const check = DecomposeOutputSchema.safeParse(obj);
      if (check.success) parsed = check.data;
    } catch {
      parsed = null;
    }
  }

  if (!parsed || parsed.shards.length === 0) {
    log?.warn("decompose: LLM output didn't match schema", {
      text: result.text.slice(0, 200),
    });
    return [];
  }

  // Enforce: no "general" category, dedupe by id, cap.
  const seen = new Set<string>();
  const out: Shard[] = [];
  for (const shard of parsed.shards) {
    if (out.length >= cap) break;
    if (shard.source.category === "general") continue; // re-route below
    if (seen.has(shard.id)) continue;
    seen.add(shard.id);
    out.push(shard);
  }
  return out;
}
