// =============================================================================
// Tools registry — real implementation
//
// Registers the MCP tools exposed to callers. Currently:
//   * `research` — the main entry point. Runs the main agent end-to-end.
//   * `ping`     — health check.
//
// Wires together:
//   * the Gemini LLM client
//   * all adapter implementations (subagent C)
//   * the real parse layer (subagent C's src/parse/index.ts)
//   * the main agent
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "winston";
import { z } from "zod";
import { ResearchInputSchema } from "../dispatcher/types.js";
import { createGeminiClient } from "../llm/gemini.js";
import { MainAgent } from "../main-agent/index.js";
import { parseRawShards } from "../parse/index.js";
import { githubAdapter } from "../adapters/github.js";
import { redditAdapter } from "../adapters/reddit.js";
import { youtubeAdapter } from "../adapters/youtube.js";
import { searxngAdapter } from "../adapters/searxng.js";
import { hackernewsAdapter } from "../adapters/hackernews.js";
import { arxivAdapter } from "../adapters/arxiv.js";
import { wikipediaAdapter } from "../adapters/wikipedia.js";

export function registerTools(server: McpServer, ctx: { logger: Logger }): void {
  const llm = createGeminiClient();
  const mainAgent = new MainAgent({
    llm,
    // TODO: align types — the main-agent's ParseRawShardsFn has a slightly
    // narrower options shape than the parse layer's ParseRawOptions. They
    // are structurally compatible today, so the cast is safe.
    parseRawShards: parseRawShards as any,
    adapters: {
      web: searxngAdapter, // web category — searxng handles it
      github: githubAdapter,
      reddit: redditAdapter,
      youtube: youtubeAdapter,
      hackernews: hackernewsAdapter,
      arxiv: arxivAdapter,
      wikipedia: wikipediaAdapter,
      // osm and generic are source ids that map to "web" in the registry,
      // so only one wins. The generic adapter is the safer default for
      // unknown URLs. For "web" we use searxng. OSM users will need
      // scope=["osm"] in v2 (not yet supported by dispatcher types).
      // crawl4aiAdapter / osmAdapter / genericAdapter are imported only
      // for the side-effect of registering them with the runtime; the
      // dispatcher registry currently only keys on SourceCategory.
    },
    logger: ctx.logger,
  });

  server.tool(
    "research",
    "Run a multi-source research task. Decomposes the prompt, dispatches parallel sub-agents across the requested sources, then synthesizes an answer.",
    ResearchInputSchema.shape, // zod raw shape for the SDK
    async (args: unknown) => {
      const out = await mainAgent.research(args);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.tool(
    "ping",
    "Health check — returns ok if the main agent can answer.",
    { input: z.string().optional() },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
}
