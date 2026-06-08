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
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
  /** Total token budget for the main agent (covers decompose + review + synthesize). */
  tokenBudget?: number;
  /** Total wall-clock budget per request, seconds. */
  timeBudgetSec?: number;
  /** Adapters owned by subagent C. Pass them in via main(). */
  adapters?: ShardAdapterRegistry;
  /**
   * Parse layer — owned by subagent C. We inject a function so we can ship
   * a stub now and swap in the real implementation later. The function takes
   * a list of raw shard result files and returns the parsed chunks. The
   * main agent NEVER sees raw content.
   */
  parseRawShards?: ParseRawShardsFn;
  /** Optional per-request logger. */
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
}

/** Function signature subagent C must implement for the parse layer. */
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
// Stub parse layer — used until subagent C wires in the real one.
//
// Reads each shard's artifact file, looks for the shape the real parse
// layer is expected to produce, and returns that. If the file is the
// "error envelope" the dispatcher writes on failure, it returns a
// zero-chunk ParsedShard so the main agent still sees the failure.
// ---------------------------------------------------------------------------

const ParsedArtifactSchema = z.object({
  shardId: z.string().min(1),
  source: z.enum(["web", "github", "reddit", "youtube", "hackernews", "arxiv", "wikipedia"]),
  summary: z.string(),
  chunks: z.array(
    z.object({
      text: z.string(),
      url: z.string().optional(),
      charOffset: z.number().int().nonnegative(),
      tokenCount: z.number().int().nonnegative(),
    }),
  ),
});

export const stubParseRawShards: ParseRawShardsFn = async (shardResults, options) => {
  const out: ParsedShard[] = [];
  for (const r of shardResults) {
    if (!r.ok || !r.rawPath) {
      out.push({
        shardId: r.shardId,
        source: "web",
        summary: r.error ? `Shard failed: ${r.error}` : "Shard produced no output.",
        chunks: [],
      });
      continue;
    }
    try {
      const raw = await readFile(r.rawPath, "utf8");
      // Try the parsed-artifact shape first; fall back to a generic wrapper.
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && "chunks" in obj) {
        const check = ParsedArtifactSchema.safeParse(obj);
        if (check.success) {
          // Cap per shard.
          out.push({
            shardId: check.data.shardId,
            source: check.data.source,
            summary: check.data.summary,
            chunks: check.data.chunks.slice(0, options.maxChunksPerShard),
          });
          continue;
        }
      }
      // Last-ditch: wrap any raw JSON as a single "chunks" entry.
      out.push({
        shardId: r.shardId,
        source: "web",
        summary: "Raw artifact was not in expected parse shape; showing as single chunk.",
        chunks: [
          {
            text: typeof obj === "string" ? obj : JSON.stringify(obj).slice(0, 4000),
            charOffset: 0,
            tokenCount: Math.ceil(JSON.stringify(obj).length / 4),
          },
        ],
      });
    } catch (err) {
      out.push({
        shardId: r.shardId,
        source: "web",
        summary: `Parse failed: ${err instanceof Error ? err.message : String(err)}`,
        chunks: [],
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export class MainAgent {
  private readonly llm: LLMClient | null;
  private readonly dataDir: string;
  private readonly concurrency: number;
  private readonly shardTimeoutMs: number;
  private readonly tokenBudget: number;
  private readonly timeBudgetSec: number;
  private readonly adapters: ShardAdapterRegistry;
  private readonly parseRawShards: ParseRawShardsFn;
  private readonly logger: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;

  constructor(config: MainAgentConfig) {
    this.llm = config.llm;
    this.dataDir = (config.dataDir ?? process.env["EYES_DATA_DIR"] ?? "/data").replace(/\/$/, "");
    this.concurrency = config.concurrency ?? 4;
    this.shardTimeoutMs = config.shardTimeoutMs ?? 30_000;
    this.tokenBudget = config.tokenBudget ?? Number.parseInt(process.env["EYES_TOKEN_BUDGET"] ?? "80000", 10);
    this.timeBudgetSec = config.timeBudgetSec ?? Number.parseInt(process.env["EYES_TIME_BUDGET_SEC"] ?? "120", 10);
    this.adapters = config.adapters ?? {};
    this.parseRawShards = config.parseRawShards ?? stubParseRawShards;
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

    // Token tracking across the whole request.
    let tokensIn = 0;
    let tokensOut = 0;
    const t0 = start;

    // Available sources: expand "general" to the standard set.
    const availableSources = expandScope(input.scope);

    // First decompose.
    let shards: Shard[] = await decompose(input.prompt, availableSources, input.maxShards, this.llm, {
      logger: log,
    });
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
          usedTokens: tokensIn + tokensOut,
          tokenBudget: this.tokenBudget,
          logger: log,
        },
      );

      if (decision.type === "return") {
        log.info("main-agent: returning answer", { iter, chars: decision.answer.length });
        return this.buildOutput(
          input,
          decision.answer,
          allShardsMeta,
          iterations,
          tokensIn,
          tokensOut,
          Date.now() - start,
        );
      }

      // decision.type === "refine"
      lastReviewReason = decision.reason;
      log.info("main-agent: refining", { iter, reason: decision.reason, newShards: decision.newShards.length });

      // Token-budget gate before allowing more iteration.
      if (tokensIn + tokensOut >= this.tokenBudget) {
        log.warn("main-agent: token budget hit during refine, synthesizing with what we have");
        const answer = await synthesize(allParsedShards, input.prompt, this.llm, {
          outputFormat: input.outputFormat,
          logger: log,
        });
        return this.buildOutput(
          input,
          answer,
          allShardsMeta,
          iterations,
          tokensIn,
          tokensOut,
          Date.now() - start,
        );
      }

      shards = decision.newShards;
    }

    // Loop exhausted (or broke out on time budget) — synthesize with what we have.
    log.info("main-agent: loop exhausted, synthesizing", { iterations, lastReason: lastReviewReason });
    const answer = await synthesize(allParsedShards, input.prompt, this.llm, {
      outputFormat: input.outputFormat,
      logger: log,
    });
    return this.buildOutput(
      input,
      answer,
      allShardsMeta,
      iterations,
      tokensIn,
      tokensOut,
      Date.now() - start,
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
  ): ResearchOutput {
    return {
      answer,
      shards,
      iterations,
      tokensIn,
      tokensOut,
      durationMs,
      mode: this.llm?.isConfigured ? "llm" : "heuristic",
    };
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
