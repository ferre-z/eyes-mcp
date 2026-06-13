// =============================================================================
// Eyes-MCP — main agent
//
// The only LLM in the system. Owns the decompose → dispatch → wait →
// review → refine/return loop. Tracks token budget, time budget, and
// iteration cap. Exposes a single `research(input)` method that returns a
// ResearchOutput.
//
// Architecture: docs/03-architecture-main-and-swarm.md
//   caller -> [main agent LLM] -> [N async coroutines / shards] -> parse L1
//   -> parse L2 -> [main agent reviews] -> loop or return
// =============================================================================

import { randomUUID } from "node:crypto";
import path from "node:path";
import { logger as rootLogger } from "../util/logger.js";
import type { LLMClient } from "../llm/client.js";
import type {
  Depth,
  ParsedShard,
  ResearchInput,
  ResearchOutput,
  Shard,
  ShardAdapterRegistry,
  Source,
  SourceCategory,
} from "../dispatcher/types.js";
import { ResearchInputSchema } from "../dispatcher/types.js";
import { dispatchShards } from "../dispatcher/index.js";
import { decompose } from "./decompose.js";
import { review } from "./review.js";
import { synthesize } from "./synthesize.js";

/** Per-step LLM outcome, tracked across the run to report an honest `mode`. */
interface LlmPathTracker {
  /** True if any of the LLM calls (decompose / review / synthesize) succeeded. */
  llmAttempted: boolean;
  /** True if at least one LLM call SUCCEEDED (vs fell back to heuristic). */
  llmSucceeded: boolean;
}
function freshLlmPath(): LlmPathTracker {
  return { llmAttempted: false, llmSucceeded: false };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MainAgentConfig {
  /** LLM client (Gemini / Gemma 4 31B). May be null for heuristic-only mode. */
  llm: LLMClient | null;
  /** Where adapter raw artifacts live. Default: $EYES_DATA_DIR or /data. */
  dataDir?: string;
  /** Dispatcher concurrency. Default 4. */
  concurrency?: number;
  /** Per-shard timeout, ms. Default 30000. */
  shardTimeoutMs?: number;
  /** Reuse shard artifacts younger than this many ms. Default 0 (disabled). */
  shardCacheTtlMs?: number;
  /** Total token budget for the main agent (covers decompose + review + synthesize). */
  tokenBudget?: number;
  /** Total wall-clock budget per request, seconds. */
  timeBudgetSec?: number;
  /** Adapters owned by subagent C. Pass them in via main(). */
  adapters?: ShardAdapterRegistry;
  /**
   * Parse layer — REQUIRED. The function takes a list of raw shard result
   * files and returns the parsed chunks. The main agent NEVER sees raw
   * content. The production wiring is `parseRawShards` from
   * `src/parse/index.js`; both the MCP server (src/tools/index.ts) and the
   * CLI (src/cli/chat.ts) inject it.
   */
  parseRawShards: ParseRawShardsFn;
  /** Optional per-request logger. */
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
}

/** Function signature the parse layer must implement. */
export type ParseRawShardsFn = (
  shardResults: ReadonlyArray<{ shardId: string; ok: boolean; rawPath?: string; error?: string }>,
  options: { dataDir: string; maxChunksPerShard: number; depth: Depth },
) => Promise<ParsedShard[]>;

/** Per-shard chunk cap driven by depth. Matches the architecture doc. */
const DEPTH_CHUNK_CAPS = { quick: 20, standard: 50, deep: 100 } as const;

const SOURCE_CATEGORIES: ReadonlyArray<SourceCategory> = [
  "web",
  "github",
  "reddit",
  "youtube",
  "hackernews",
  "arxiv",
  "wikipedia",
];

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export class MainAgent {
  private readonly llm: LLMClient | null;
  private readonly dataDir: string;
  private readonly concurrency: number;
  private readonly shardTimeoutMs: number;
  private readonly shardCacheTtlMs: number;
  private readonly tokenBudget: number;
  private readonly timeBudgetSec: number;
  private readonly adapters: ShardAdapterRegistry;
  private readonly parseRawShards: ParseRawShardsFn;
  private readonly logger: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;

  constructor(config: MainAgentConfig) {
    if (!config.parseRawShards) {
      // Defensive runtime guard. TS already requires it on the type, but
      // a `as any` cast at a callsite would silently bypass the type.
      // Failing loudly here is the whole point of removing the stub.
      throw new Error(
        "MainAgent requires `parseRawShards` (import { parseRawShards } from '../parse/index.js'). " +
          "The old stub parser is gone — it only understood an on-disk shape no adapter writes.",
      );
    }
    this.llm = config.llm;
    this.dataDir = (config.dataDir ?? process.env["EYES_DATA_DIR"] ?? "/data").replace(/\/$/, "");
    this.concurrency = config.concurrency ?? 4;
    this.shardTimeoutMs = config.shardTimeoutMs ?? 30_000;
    this.shardCacheTtlMs = config.shardCacheTtlMs ?? 0;
    this.tokenBudget = config.tokenBudget ?? Number.parseInt(process.env["EYES_TOKEN_BUDGET"] ?? "80000", 10);
    this.timeBudgetSec = config.timeBudgetSec ?? Number.parseInt(process.env["EYES_TIME_BUDGET_SEC"] ?? "120", 10);
    this.adapters = config.adapters ?? {};
    this.parseRawShards = config.parseRawShards;
    this.logger = config.logger ?? rootLogger;
  }

  /**
   * Run a full research request: decompose, dispatch, parse, review, loop.
   * Always returns a ResearchOutput — never throws on agent errors. The
   * caller gets the best answer we can build within the budgets.
   */
  async research(rawInput: unknown): Promise<ResearchOutput> {
    // Validate input against the Zod schema (with defaults applied).
    const input = ResearchInputSchema.parse(rawInput);
    const requestId = randomUUID().slice(0, 8);
    const log = (this.logger as typeof rootLogger).child
      ? (this.logger as typeof rootLogger).child({ requestId })
      : this.logger;
    const start = Date.now();

    log.info("main-agent: research started", {
      prompt: input.prompt.slice(0, 100),
      depth: input.depth,
      maxShards: input.maxShards,
      maxIterations: input.maxIterations,
      mode: this.llm?.isConfigured ? "llm" : "heuristic",
    });

    // Token tracking across the whole request. Decompose, review, and
    // synthesize each update this object when they make an LLM call.
    const counters: { tokensIn: number; tokensOut: number } = { tokensIn: 0, tokensOut: 0 };
    const t0 = start;
    // Track whether LLM actually produced output (vs falling back to heuristic).
    const llmPath = freshLlmPath();

    // Available sources: expand "general" to the standard set.
    const availableSources = expandScope(input.scope);

    // First decompose.
    let shards: Shard[] = await decompose(input.prompt, availableSources, input.maxShards, this.llm, {
      logger: log,
      counters,
    });
    // Track whether decompose fell back to heuristic. Heuristic decompose
    // returns a valid answer with a clearly-identifiable marker.
    const decomposeUsedHeuristic = shards.length > 0 && shards[0]?.why?.startsWith("[heuristic]") === true;
    if (this.llm?.isConfigured) {
      llmPath.llmAttempted = true;
      if (!decomposeUsedHeuristic) llmPath.llmSucceeded = true;
    }
    if (shards.length === 0) {
      // Shouldn't happen — heuristic guarantees ≥ 1 — but be safe.
      shards = [{
        id: "web-fallback",
        query: input.prompt,
        source: { category: "web" },
        why: "Decompose returned nothing; sending a single web shard as fallback.",
      }];
    }
    const allShardsMeta: ResearchOutput["shards"] = [];
    const allParsedShards: ParsedShard[] = [];
    let iterations = 0;
    let lastReviewReason: string | null = null;

    for (let iter = 1; iter <= input.maxIterations; iter++) {
      iterations = iter;

      // Time budget check.
      const elapsedSec = (Date.now() - t0) / 1000;
      if (elapsedSec > this.timeBudgetSec) {
        log.warn("main-agent: time budget hit, stopping loop", { elapsedSec, budget: this.timeBudgetSec });
        break;
      }

      log.info("main-agent: dispatching iteration", { iter, count: shards.length });

      // Dispatch.
      const rawResults = await dispatchShards(shards, input.depth, {
        dataDir: this.dataDir,
        concurrency: this.concurrency,
        timeoutMs: this.shardTimeoutMs,
        shardCacheTtlMs: this.shardCacheTtlMs,
        adapters: this.adapters,
        logger: log,
      });

      // Track metadata.
      for (let i = 0; i < rawResults.length; i++) {
        const r = rawResults[i]!;
        const src = shards[i]?.source ?? { category: "web" as SourceCategory };
        allShardsMeta.push({
          id: r.shardId,
          source: src.category,
          query: shards[i]?.query ?? "",
          why: shards[i]?.why ?? "",
          ok: r.ok,
          chunkCount: 0, // filled in after parse
        });
      }

      // Parse.
      const parsed = await this.parseRawShards(
        rawResults.map((r) => ({
          shardId: r.shardId,
          ok: r.ok,
          ...(r.rawPath !== undefined ? { rawPath: r.rawPath } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
        { dataDir: this.dataDir, maxChunksPerShard: DEPTH_CHUNK_CAPS[input.depth], depth: input.depth },
      );
      for (const p of parsed) {
        allParsedShards.push(p);
        // Update chunk count in the metadata.
        const meta = allShardsMeta.find((m) => m.id === p.shardId);
        if (meta) meta.chunkCount = p.chunks.length;
      }

      // Review.
      const remaining = input.maxIterations - iter;
      const decision = await review(
        allParsedShards,
        input.prompt,
        availableSources,
        this.llm,
        {
          remainingIterations: remaining,
          maxShards: input.maxShards,
          usedTokens: counters.tokensIn + counters.tokensOut,
          tokenBudget: this.tokenBudget,
          logger: log,
          counters,
        },
      );
      // `review` only returns type=refine when the LLM actually produced
      // a refine decision. If it fell back, we get type=return with a
      // heuristic summary. Track which path it took — both for the case
      // where the agent returns immediately AND for the case where it
      // says "refine" (which means LLM DID run for review).
      if (this.llm?.isConfigured) {
        if (decision.type === "return") {
          // Heuristic summary starts with "Findings for:". LLM summaries do not.
          if (!decision.answer.startsWith("Findings for:") && decision.answer.length > 0) {
            llmPath.llmSucceeded = true;
          }
        } else if (decision.type === "refine") {
          // type=refine is only produced by the LLM path.
          llmPath.llmSucceeded = true;
        }
      }

      if (decision.type === "return") {
        log.info("main-agent: returning answer", { iter, chars: decision.answer.length });
        // Re-format the review's answer through synthesize() when the caller
        // asked for a non-default outputFormat. The review step always returns
        // a markdown-ish narrative, but the user may have asked for json or
        // summary. Force the LLM path off here so we don't burn a second
        // call — synthesize's heuristic path respects outputFormat.
        let finalAnswer = decision.answer;
        if (input.outputFormat !== "markdown") {
          // synthesize()'s no-chunks branch returns a flat "No evidence was
          // found..." string; we wrap it for json/summary callers.
          if (allParsedShards.some((s) => s.chunks.length > 0)) {
            finalAnswer = await synthesize(allParsedShards, input.prompt, null, {
              outputFormat: input.outputFormat,
              logger: log,
            });
          } else if (input.outputFormat === "json") {
            finalAnswer = JSON.stringify({
              answer: finalAnswer,
              key_points: [],
              sources: [],
            });
          }
        }
        return this.buildOutput(
          input,
          finalAnswer,
          allShardsMeta,
          iterations,
          counters.tokensIn,
          counters.tokensOut,
          Date.now() - start,
          llmPath,
        );
      }

      // decision.type === "refine"
      lastReviewReason = decision.reason;
      log.info("main-agent: refining", { iter, reason: decision.reason, newShards: decision.newShards.length });

      // Token-budget gate before allowing more iteration.
      if (counters.tokensIn + counters.tokensOut >= this.tokenBudget) {
        log.warn("main-agent: token budget hit during refine, synthesizing with what we have");
        const answer = await trackSynthesizeLlm(
          allParsedShards,
          input.prompt,
          this.llm,
          { outputFormat: input.outputFormat, logger: log, counters },
          llmPath,
        );
        return this.buildOutput(
          input,
          answer,
          allShardsMeta,
          iterations,
          counters.tokensIn,
          counters.tokensOut,
          Date.now() - start,
          llmPath,
        );
      }

      shards = decision.newShards;
    }

    // Loop exhausted (or broke out on time budget) — synthesize with what we have.
    log.info("main-agent: loop exhausted, synthesizing", { iterations, lastReason: lastReviewReason });
    const answer = await trackSynthesizeLlm(
      allParsedShards,
      input.prompt,
      this.llm,
      { outputFormat: input.outputFormat, logger: log, counters },
      llmPath,
    );
    return this.buildOutput(
      input,
      answer,
      allShardsMeta,
      iterations,
      counters.tokensIn,
      counters.tokensOut,
      Date.now() - start,
      llmPath,
    );
  }

  private buildOutput(
    input: ResearchInput,
    answer: string,
    shards: ResearchOutput["shards"],
    iterations: number,
    tokensIn: number,
    tokensOut: number,
    durationMs: number,
    llmPath: LlmPathTracker,
  ): ResearchOutput {
    // Honest `mode`: report `llm` only if an LLM was configured AND at
    // least one LLM call (decompose / review / synthesize) actually
    // produced a non-fallback result. Otherwise report `heuristic`.
    const mode: ResearchOutput["mode"] =
      this.llm?.isConfigured && llmPath.llmSucceeded ? "llm" : "heuristic";
    return { answer, shards, iterations, tokensIn, tokensOut, durationMs, mode };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand "general" scope entries to the full standard set. */
function expandScope(scope: ReadonlyArray<SourceCategory>): Source[] {
  const out: Source[] = [];
  for (const cat of scope) {
    if (cat === "general") {
      for (const c of SOURCE_CATEGORIES) {
        if (!out.some((x) => x.category === c)) out.push({ category: c });
      }
    } else if (!out.some((x) => x.category === cat)) {
      out.push({ category: cat });
    }
  }
  return out;
}

/** Re-export for tests + tools. */
export { ResearchInputSchema };
export type { ResearchInput };

// ---------------------------------------------------------------------------
// Helper: call `synthesize` and mark llmPath.llmSucceeded when the LLM
// path actually produced the final answer. Heuristic synthesis produces
// "No evidence was found..." or "# Findings: ..." — we treat those as
// fallback markers.
// ---------------------------------------------------------------------------
async function trackSynthesizeLlm(
  shards: ReadonlyArray<ParsedShard>,
  prompt: string,
  llm: LLMClient | null,
  options: { outputFormat: "markdown" | "json" | "summary"; logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">; counters?: { tokensIn: number; tokensOut: number } },
  llmPath: LlmPathTracker,
): Promise<string> {
  const answer = await synthesize(shards, prompt, llm, options);
  if (llm?.isConfigured) {
    // Heuristic synthesize produces a known shape. Anything else is LLM output.
    const looksHeuristic =
      answer.startsWith("No evidence was found") ||
      answer.startsWith("# Findings:") ||
      answer.startsWith("Findings for:");
    if (!looksHeuristic) llmPath.llmSucceeded = true;
  }
  return answer;
}
