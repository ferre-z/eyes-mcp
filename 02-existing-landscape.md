# Existing landscape (what's already out there)

> What we need to be different from. June 2026.

## Direct "SearXNG + Crawl4AI as MCP" competitors
| Project | Stars | Notes |
|---|---|---|
| `crawl4ai-rag-mcp` (ToKiDoO) | 42 | Adds RAG layer on top of crawl4ai |
| `searxng-crawl4ai-mcp` (luxiaolei) | 27 | TypeScript, "3x faster" claim |
| `mcp-searxng-enhanced` (OvertliDS) | 49 | Category-aware search + scraping |
| `searxng-mcp` (tisDDM) | 42 | Thin wrapper |
| `one-search-mcp` (yokingma) | 117 | Multi-provider, broader |

**Verdict:** all do "SearXNG + Crawl4AI + MCP + Docker". Adding GitHub/Reddit/YouTube + swarm = **6th me-too entry** if we don't pick a real differentiator.

## Reference swarm projects
| Project | Stars | Pattern |
|---|---|---|
| **gpt-researcher** (assafelovic) | 27.5k | Planner → parallel researchers → publisher (canonical 3-agent) |
| **CoexistAI** (SPThole) | 489 | Web/Reddit/YouTube/GitHub **explorers**, each its own pipeline |
| **AdvancedResearch** (The-Swarm-Corporation) | 31 | Anthropic orchestrator-worker pattern, on `swarms` lib |
| **gptr-mcp** (assafelovic) | 351 | GPT-Researcher wrapped as MCP |
| **OpenOSINT** | 538 | AI OSINT agent, 16 tools, CLI + MCP |

**Insight from CoexistAI:** the explorer pattern (one mini-pipeline per source) is closest to your idea. They've shipped it.

## MCP ecosystem signals
- **MCP Registry** is live in **v0.1 API freeze** (Oct 2025) — `modelcontextprotocol/registry`
- Official `servers` repo is **only reference implementations** now, community lists in the registry
- Top MCP stars: `hexstrike-ai` (9.4k), `arxiv-mcp-server` (2.8k), `crawl4ai-rag` (2.2k), `notebooklm-mcp` (2.7k)
- Winners consistently have either (a) **unique data source** or (b) **unique processing model**

## Anthropic's own research (the source-of-truth post)
https://www.anthropic.com/engineering/built-multi-agent-research-system

Key claims:
- Orchestrator-worker pattern is consensus
- Multi-agent beat single-agent by **90%** on breadth-first queries
- Cost: **15× chat tokens**, token budget is the constraint
- **Artifact pattern**: workers write to filesystem, coordinator gets pointers (not raw text)
- Synchronous subagents are a bottleneck — async is the future

## Differentiator candidates (for our v1)
```
A. "Citation-correct"   — every claim → URL+quote+confidence   (hardest, most defensible)
B. "Zero-friction"      — no LLM key, no API key, docker up works  (easiest, biggest wedge)
C. "Shared service"     — streamable HTTP, multi-tenant, queue, rate limits  (fits "for others")
```

**My recommendation:** **B + C** for v1. Swarm = v2 behind a flag. A is the long-term play but you'll be playing catch-up with gpt-researcher.
