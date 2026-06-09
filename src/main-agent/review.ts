// =============================================================================
// Eyes-MCP — review step
//
// The main agent looks at all parsed shards and decides: am I done, or do I
// need to send out more shards to fill a specific gap? In heuristic mode (no
// LLM), this is a simple "do I have any chunks? then return" check.
// =============================================================================

import { z } from "zod";
import { logger as rootLogger } from "../util/logger.js";
import type { LLMClient } from "../llm/client.js";
import { buildReviewPrompt } from "../llm/prompts.js";
import type { TokenCounters } from "./decompose.js";
import type {
  ParsedShard,
  ReviewDecision,
  Shard,
  Source,
} from "../dispatcher/types.js";

/** Zod schema for the LLM's review response. */
const ReviewOutputSchema = z.object({
  decision: z.enum(["return", "refine"]),
  // Present when decision === "return"
  answer: z.string().optional(),
  // Present when decision === "refine"
  newShards: z
    .array(
      z.object({
        id: z.string().min(1),
        query: z.string().min(1),
        source: z.object({
          category: z.enum([
            "general",
            "web",
            "github",
            "reddit",
            "youtube",
            "hackernews",
            "arxiv",
            "wikipedia",
          ]),
          hint: z.string().optional(),
        }),
        why: z.string().min(1),
      }),
    )
    .optional(),
  reason: z.string().optional(),
});
type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export interface ReviewOptions {
  remainingIterations: number;
  maxShards: number;
  usedTokens: number;
  tokenBudget: number;
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
  /** Optional mutable counters — populated with the LLM call's token usage. */
  counters?: TokenCounters;
}

/**
 * Review the parsed shards and decide what to do next.
 *
 * In LLM mode: ask the model, parse structured output, return its decision.
 * In heuristic mode: if any shard produced chunks, synthesize a quick
 *                    answer locally; otherwise propose a single web shard
 *                    to retry.
 */
export async function review(
  shards: ReadonlyArray<ParsedShard>,
  originalPrompt: string,
  availableSources: ReadonlyArray<Source>,
  llm: LLMClient | null,
  options: ReviewOptions,
): Promise<ReviewDecision> {
  const log = options.logger ?? rootLogger;
  const totalChunks = shards.reduce((acc, s) => acc + s.chunks.length, 0);

  // If there's literally nothing, bail out with a polite message rather than
  // burning another iteration.
  if (totalChunks === 0) {
    if (options.remainingIterations <= 0) {
      return {
        type: "return",
        answer:
          "No evidence was found across the requested sources. " +
          "Try widening the scope (e.g. add 'web' or 'general') or rephrasing the question.",
      };
    }
    return {
      type: "refine",
      newShards: [
        {
          id: "web-retry",
          query: originalPrompt,
          source: { category: "web" },
          why: "First iteration returned no chunks; retry with a broader web search.",
        },
      ],
      reason: "No evidence was collected on the first pass.",
    };
  }

  if (llm && llm.isConfigured) {
    try {
      const decision = await llmReview(
        shards,
        originalPrompt,
        availableSources,
        llm,
        options,
        log,
        options.counters,
      );
      return decision;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("review: LLM call failed, using heuristic fallback", { err: message });
    }
  }

  // Heuristic fallback: return what we have.
  return {
    type: "return",
    answer: heuristicSummary(shards, originalPrompt),
  };
}

async function llmReview(
  shards: ReadonlyArray<ParsedShard>,
  originalPrompt: string,
  availableSources: ReadonlyArray<Source>,
  llm: LLMClient,
  options: ReviewOptions,
  log: ReviewOptions["logger"],
  counters: TokenCounters | undefined,
): Promise<ReviewDecision> {
  const fullPrompt = buildReviewPrompt({
    originalPrompt,
    shardSummaries: shards.map((s) => ({
      id: s.shardId,
      source: s.source,
      summary: s.summary,
      chunkCount: s.chunks.length,
    })),
    availableSources,
    remainingIterations: options.remainingIterations,
    maxShards: options.maxShards,
    usedTokens: options.usedTokens,
    tokenBudget: options.tokenBudget,
  });

  const result = await llm.generate(fullPrompt, {
    responseSchema: ReviewOutputSchema,
    temperature: 0.2,
    maxTokens: 2048,
  });
  if (counters) {
    counters.tokensIn += result.tokensIn;
    counters.tokensOut += result.tokensOut;
  }

  let parsed: ReviewOutput | null = null;
  if (result.structured) {
    const check = ReviewOutputSchema.safeParse(result.structured);
    if (check.success) parsed = check.data;
  }
  if (!parsed) {
    try {
      parsed = ReviewOutputSchema.parse(JSON.parse(result.text));
    } catch {
      log?.warn("review: LLM output didn't match schema", {
        text: result.text.slice(0, 200),
      });
      return { type: "return", answer: heuristicSummary(shards, originalPrompt) };
    }
  }

  if (parsed.decision === "return" && parsed.answer && parsed.answer.length > 0) {
    return { type: "return", answer: parsed.answer };
  }
  if (
    parsed.decision === "refine" &&
    parsed.newShards &&
    parsed.newShards.length > 0 &&
    parsed.reason
  ) {
    // Filter out "general" categories — they're not a real source.
    const valid: Shard[] = parsed.newShards
      .filter((s) => s.source.category !== "general")
      .slice(0, options.maxShards);
    if (valid.length === 0) {
      return { type: "return", answer: heuristicSummary(shards, originalPrompt) };
    }
    return { type: "refine", newShards: valid, reason: parsed.reason };
  }
  // Incomplete LLM response — be safe and return.
  return { type: "return", answer: heuristicSummary(shards, originalPrompt) };
}

/**
 * Tiny deterministic summary used when no LLM is around. Just lists what
 * each shard found — not a real answer, but useful for callers that want
 * raw structure rather than a polished narrative.
 */
function heuristicSummary(shards: ReadonlyArray<ParsedShard>, originalPrompt: string): string {
  const lines: string[] = [];
  lines.push(`Findings for: ${originalPrompt}`);
  lines.push("");
  for (const s of shards) {
    if (s.chunks.length === 0) continue;
    lines.push(`### [${s.source}] ${s.shardId}`);
    lines.push(s.summary);
    lines.push("");
  }
  if (lines.length === 2) {
    return "No findings.";
  }
  return lines.join("\n").trim();
}
