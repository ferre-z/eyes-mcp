// =============================================================================
// Eyes-MCP — prompt templates for the main agent
//
// Kept as exported string constants so they're easy to grep, easy to test
// (just substring-match in vitest), and easy to override per-request later
// (e.g. callers can pass a `promptOverride`).
//
// All prompts produce structured output. The Zod schema in the matching
// `*.ts` file is the source of truth for the expected output shape.
// =============================================================================

/** Shard list shape used in the decomposer's output. */
const SHARD_RULES = `
Each shard MUST be a JSON object with exactly these fields:
  - "id":     short string, slugified from the query (e.g. "github-llm-frameworks")
  - "query":  the actual search query to run, ready to paste into a search engine
  - "source": one of "web" | "github" | "reddit" | "youtube" | "hackernews" | "arxiv" | "wikipedia"
  - "why":    one sentence explaining why this shard exists

Do NOT use "general" as a source — pick a real category.
Do NOT return more than {maxShards} shards.
Return ONLY shards that are likely to surface *unique* information.
`;

/** Available source list — passed in by the caller so the model sees real options. */
function sourceList(sources: ReadonlyArray<{ category: string; hint?: string }>): string {
  if (sources.length === 0) return "(no specific sources — pick from the standard set)";
  return sources
    .map((s) => `- ${s.category}${s.hint ? ` (hint: ${s.hint})` : ""}`)
    .join("\n");
}

export interface DecomposePromptContext {
  prompt: string;
  availableSources: ReadonlyArray<{ category: string; hint?: string }>;
  maxShards: number;
}

/** Prompt: ask the LLM to break a research question into parallel shards. */
export function buildDecomposePrompt(ctx: DecomposePromptContext): string {
  return `You are a research planner. Your job is to break a single research question
into a small set of parallel sub-tasks ("shards") that can each be researched
independently by an automated sub-agent.

## Original question
${ctx.prompt}

## Available sources (the sub-agents can use these)
${sourceList(ctx.availableSources)}

## Constraints
- Maximum shards: ${ctx.maxShards}
- Each shard targets exactly ONE source category.
- Shards should cover DIFFERENT ANGLES of the question, not redundant rephrasings.
- Be concise — you are decomposing, not answering.

${SHARD_RULES.replace("{maxShards}", String(ctx.maxShards))}

## Output format
Return a single JSON object:
{
  "shards": [ <shard>, <shard>, ... ]
}
`;
}

/** Prompt: ask the LLM whether the parsed shards answer the question, or refine. */
export interface ReviewPromptContext {
  originalPrompt: string;
  shardSummaries: ReadonlyArray<{ id: string; source: string; summary: string; chunkCount: number }>;
  availableSources: ReadonlyArray<{ category: string; hint?: string }>;
  remainingIterations: number;
  maxShards: number;
  usedTokens: number;
  tokenBudget: number;
}

export function buildReviewPrompt(ctx: ReviewPromptContext): string {
  const summaries = ctx.shardSummaries
    .map((s) => `- [${s.source}] ${s.id} (${s.chunkCount} chunks): ${s.summary}`)
    .join("\n");

  return `You are the lead researcher reviewing the evidence so far. You started with
the original question, dispatched parallel sub-agents to research it, and
now you must decide: do you have enough to answer, or do you need to send
out more sub-agents to fill gaps?

## Original question
${ctx.originalPrompt}

## Evidence collected so far
${summaries}

## Available sources (you can dispatch more shards to these)
${sourceList(ctx.availableSources)}

## Constraints
- Remaining refinement iterations: ${ctx.remainingIterations}
- Max shards per iteration: ${ctx.maxShards}
- Tokens used so far: ${ctx.usedTokens} / ${ctx.tokenBudget}

## Your job
Read the evidence. Either:
  (a) Return a final answer to the caller, OR
  (b) Propose 1-${ctx.maxShards} NEW shards that would fill specific gaps.
      The new shards must target DIFFERENT angles from what's already been
      collected (no redundancy).

## Output format (strict JSON)
{
  "decision": "return" | "refine",
  // if "return":
  "answer": "<the synthesized answer to the original question, citing which shards informed which claims>",
  // if "refine":
  "newShards": [ <shard>, <shard>, ... ],
  "reason": "<one sentence: what's still missing and why these shards will fill it>"
}

Pick "return" if the evidence is sufficient. Pick "refine" if there's a
clear, articulable gap that more research could fill. Don't refine for
the sake of it.
`;
}

/** Prompt: ask the LLM to write the final answer in the caller's format. */
export interface SynthesizePromptContext {
  originalPrompt: string;
  shardSummaries: ReadonlyArray<{ id: string; source: string; summary: string }>;
  chunkSample: string;
  outputFormat: "markdown" | "json" | "summary";
}

export function buildSynthesizePrompt(ctx: SynthesizePromptContext): string {
  const summaries = ctx.shardSummaries
    .map((s) => `- [${s.source}] ${s.id}: ${s.summary}`)
    .join("\n");

  const formatGuidance = {
    markdown: "Use GitHub-flavored markdown. Use headers, lists, and code blocks where appropriate. Cite sources inline as [source: shardId].",
    json: 'Return a JSON object with this shape: {"answer": string, "key_points": string[], "sources": [{"shard_id": string, "claim": string}]}.',
    summary: "Return a tight 2-3 sentence summary. No lists, no headers.",
  }[ctx.outputFormat];

  return `You are the lead researcher. Write the final answer to the caller's question
using ONLY the evidence your sub-agents collected. Your output will be shown
to the user verbatim — anything you write is part of the answer.

## Original question
${ctx.originalPrompt}

## Shard summaries (one per research angle)
${summaries}

## Raw chunk sample (the highest-signal excerpts across all shards)
"""
${ctx.chunkSample}
"""

## Output format
${formatGuidance}

## Rules
- Be precise. If the evidence doesn't support a claim, don't make it.
- Cite your sources inline (use shard IDs like [web:abc123]).
- Don't pad. If the answer is "no good evidence was found", say so plainly.
- DO NOT include any of the following — they are NOT for the user:
    * Internal reasoning or thinking (no <thought>...</thought> blocks,
      no "Note that the evidence...", no self-commentary).
    * Lines starting with // (those are scratch notes, not answer text).
    * The literal shard metadata strings like "Findings for:", "Query:",
      "total: N items", "ok: true note: ...". Those are debug dumps.
    * Any meta-commentary about the prompt, the chunks, or the task.
- Just write the answer.
`;
}
