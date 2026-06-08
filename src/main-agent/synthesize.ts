// =============================================================================
// Eyes-MCP — synthesize step
//
// Produces the final answer to the caller's question. In LLM mode the model
// writes it. In heuristic mode we assemble a markdown summary from the
// shard summaries + a small sample of high-signal chunks.
// =============================================================================

import { logger as rootLogger } from "../util/logger.js";
import type { LLMClient } from "../llm/client.js";
import { buildSynthesizePrompt } from "../llm/prompts.js";
import type { OutputFormat, ParsedShard } from "../dispatcher/types.js";

const CHUNK_SAMPLE_CHARS = 6000;

export interface SynthesizeOptions {
  outputFormat: OutputFormat;
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
}

export async function synthesize(
  shards: ReadonlyArray<ParsedShard>,
  originalPrompt: string,
  llm: LLMClient | null,
  options: SynthesizeOptions,
): Promise<string> {
  const log = options.logger ?? rootLogger;

  const shardSummaries = shards.map((s) => ({
    id: s.shardId,
    source: s.source,
    summary: s.summary,
  }));

  // Build a chunk sample: prefer the first few chunks of each shard until
  // we hit the char budget. This is what the LLM sees as raw evidence.
  const sample = sampleChunks(shards, CHUNK_SAMPLE_CHARS);

  if (llm && llm.isConfigured) {
    try {
      const prompt = buildSynthesizePrompt({
        originalPrompt,
        shardSummaries,
        chunkSample: sample,
        outputFormat: options.outputFormat,
      });
      const result = await llm.generate(prompt, {
        temperature: 0.3,
        maxTokens: 2048,
        ...(options.outputFormat === "json" ? { structured: true } : {}),
      });
      if (result.text.trim().length > 0) {
        return result.text;
      }
      log.warn("synthesize: LLM returned empty text, falling back to heuristic");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("synthesize: LLM call failed, using heuristic fallback", { err: message });
    }
  }

  return heuristicSynthesize(shards, originalPrompt, options.outputFormat, shardSummaries);
}

function sampleChunks(shards: ReadonlyArray<ParsedShard>, budgetChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const s of shards) {
    for (const c of s.chunks) {
      const header = `[${s.source}/${s.shardId}]`;
      const piece = `${header}\n${c.text}\n\n`;
      if (used + piece.length > budgetChars) {
        // Truncate the last piece to fit.
        const remaining = budgetChars - used;
        if (remaining > 100) {
          parts.push(`${header}\n${c.text.slice(0, remaining - header.length - 4)}...`);
        }
        return parts.join("\n");
      }
      parts.push(piece);
      used += piece.length;
      if (used >= budgetChars) return parts.join("\n");
    }
  }
  return parts.join("\n");
}

function heuristicSynthesize(
  shards: ReadonlyArray<ParsedShard>,
  originalPrompt: string,
  format: OutputFormat,
  summaries: ReadonlyArray<{ id: string; source: string; summary: string }>,
): string {
  if (format === "json") {
    const obj = {
      answer: heuristicNarrative(summaries),
      key_points: summaries.map((s) => s.summary),
      sources: summaries.map((s) => ({ shard_id: s.id, claim: s.summary })),
    };
    return JSON.stringify(obj, null, 2);
  }
  if (format === "summary") {
    return heuristicNarrative(summaries).split(/(?<=\.)\s+/).slice(0, 3).join(" ");
  }
  // markdown (default)
  const lines: string[] = [];
  lines.push(`# Findings: ${originalPrompt}`);
  lines.push("");
  for (const s of shards) {
    if (s.chunks.length === 0) continue;
    lines.push(`## [${s.source}] ${s.shardId}`);
    lines.push(s.summary);
    lines.push("");
  }
  if (lines.length <= 2) {
    lines.push("_No evidence was found across the requested sources._");
  }
  return lines.join("\n").trim();
}

function heuristicNarrative(
  summaries: ReadonlyArray<{ id: string; source: string; summary: string }>,
): string {
  if (summaries.length === 0) return "No evidence was found.";
  return summaries
    .map((s, i) => `From ${s.source} (${s.id}): ${s.summary}`)
    .join(" ")
    .trim();
}
