# Eyes-MCP

[![build](https://img.shields.io/badge/build-in%20progress-yellow)]()
[![license](https://img.shields.io/badge/license-MIT-blue)]()
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()
[![mcp](https://img.shields.io/badge/MCP-streamable%20HTTP-blueviolet)]()

> **Research MCP for AI agents.** Docker-packaged. Swarm-ready. Zero required secrets.

A Model Context Protocol server that does the boring part of "go look this up on the internet" for any MCP-compatible agent. Callers send a question + a few parameters, Eyes-MCP fans out across SearXNG, Crawl4AI, GitHub, Reddit, YouTube, and more, and returns a synthesized answer with citations.

---

## What we're building

```mermaid
flowchart TD
  Caller[Caller] -->|"prompt, depth, max_shards"| MainAgent
  subgraph MainAgent ["[main agent] - the only LLM"]
    MA1[1. Read available sources]
    MA2[2. Decompose prompt into N sub-tasks]
  end
  MainAgent -->|"N shards"| SubAgents
  subgraph SubAgents ["[N sub-agents] - async coroutines, no LLM"]
    SA1[search - SearXNG / GitHub / Reddit / YouTube / ...]
    SA2[fetch - Crawl4AI / API call]
    SA3[write raw output to disk - artifact pattern]
  end
  SubAgents -->|shard_id, path| Parse1
  subgraph Parse1 ["[parse layer 1] - bloat strip, depth-driven"]
    P1[strip HTML, nav, ads, boilerplate]
  end
  Parse1 --> Parse2
  subgraph Parse2 ["[parse layer 2] - chunk + per-shard dedup"]
    P2[chunk by structure then size cap 500 tokens]
    P3[simhash dedup within shard]
  end
  Parse2 -->|chunks grouped by shard_id| Review
  subgraph Review ["[main agent] - reviews and decides"]
    R1{synthesize or spawn more shards?}
  end
  Review -->|"synthesized answer"| Caller
  Review -->|"loop with gap-fill shards"| SubAgents
```

**Decisions locked in:**
- Only the main agent is an LLM. Sub-agents = async coroutines.
- Sub-agents write raw output to disk. Main agent sees pointers + chunks, not raw.
- Parse layer 1 = bloat strip. Aggressiveness driven by the `depth` param.
- No ranking. Every chunk goes to the main agent.
- Themes = shards. Main agent's decomposition defines the themes. No re-clustering.
- Crawl4AI's output is trusted for URL-fetched content — no re-stripping.

---

## Why this is different

There are at least five "SearXNG + Crawl4AI + MCP" wrappers already (see `02-existing-landscape.md`). What makes Eyes-MCP not the 6th me-too entry:

| Differentiator | What it means |
|---|---|
| **Zero-friction install** | `docker compose up` works with no API keys. LLM is optional. |
| **Shared service** | Streamable HTTP, stateful sessions, multi-tenant. Designed to be a service, not a personal daemon. |
| **Source-aware adapters** | GitHub, Reddit, YouTube, academic — each has a dedicated adapter, not a generic search-then-scrape path. |
| **Swarm-ready** | Main agent + sub-agents + two parse layers wired from day one (swarm flag-gated in v1). |
| **Artifact pattern** | Sub-agents write to disk, main agent reads chunks. Token cost is bounded by `EYES_TOKEN_BUDGET`. |

---

## Install (laptop)

```bash
git clone https://github.com/ferre-z/eyes-mcp.git
cd eyes-mcp
npm install
npm run build
npm link                 # exposes `eyes` to your PATH
hash -r                  # ensure shell sees the new command
eyes --version           # should print 0.1.0
```

> **PATH note:** `npm link` puts `eyes` in your global `npm` bin dir. If `eyes --version` says "command not found", add that dir to PATH. Usually `~/.nvm/versions/node/v*/bin`, `~/.hermes/node/bin`, or `~/.local/bin` depending on your setup. `npm config get prefix` shows you where.

## First-time setup

```bash
eyes models pick         # interactive: provider → model → paste API key
eyes doctor              # verify everything
```

This writes `~/.config/eyes/config.toml`. Re-run any time to switch.

## Run the server

```bash
docker compose up -d     # starts searxng + crawl4ai + redis + eyes-mcp
docker compose logs -f eyes-mcp
```

Service on `http://localhost:8787` — health at `/health`, MCP at `/mcp`.

**Important:** before exposing SearXNG, replace the placeholder `secret_key` in `searxng/settings.yml`:

```bash
openssl rand -hex 32
```

## Configure

The CLI uses `~/.config/eyes/config.toml` (TOML, hand-rolled — no dep). The Docker server uses env vars only.

---

## Configure (env vars — used by the Docker server)

All configuration is via environment variables. See [`.env.example`](./.env.example) for the full list with defaults. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `EYES_HTTP_PORT` | `8787` | HTTP listen port |
| `EYES_PROVIDER` | `google-ai-studio` | `google-ai-studio` or `openrouter` |
| `EYES_MODEL` | `gemma-4-31b-it` | Model id for the chosen provider |
| `GOOGLE_AI_STUDIO_API_KEY` | _(empty)_ | Optional. If unset, server runs in heuristic-only mode. |
| `OPENROUTER_API_KEY` | _(empty)_ | Optional. Used when `EYES_PROVIDER=openrouter`. |
| `SEARXNG_URL` | `http://searxng:8080` | Internal SearXNG endpoint |
| `CRAWL4AI_URL` | `http://crawl4ai:11235` | Internal Crawl4AI endpoint |
| `GITHUB_TOKEN` | _(empty)_ | Bumps GitHub REST rate limit 60/hr → 5000/hr |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | _(empty)_ | PRAW auth (optional) |
| `EYES_MAX_SHARDS` | `5` | Max shards per request (cap 20) |
| `EYES_MAX_ITERATIONS` | `2` | Max refinement iterations (cap 5) |
| `EYES_TOKEN_BUDGET` | `80000` | Token budget for the main agent's context |
| `EYES_TIME_BUDGET_SEC` | `120` | Wall-clock budget per request |

## CLI quick reference

```bash
eyes                              # open the chat REPL
eyes "your prompt"                # one-shot research
eyes chat "prompt" --depth deep   # one-shot with depth
eyes models list                  # show all free models across providers
eyes models pick                  # interactive: provider + model + key
eyes models current               # show active provider + model
eyes config                       # interactive config editor
eyes config get providers.model   # print a config value (secrets → ***)
eyes config set providers.model llama-3.3-70b
eyes config path                  # print the config file path
eyes init                         # create the config file with defaults
eyes doctor                       # check config + deps + LLM
eyes serve                        # start the MCP HTTP server
```

---

## Usage

The server speaks the MCP **streamable HTTP** transport on `/mcp` and a plain health probe on `/health`.

```bash
curl http://localhost:8787/health
# {"status":"ok","version":"0.1.0","uptime":12,"dependencies":{...}}
```

### MCP clients that work out of the box

- **Claude Desktop** — add to `claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "eyes": {
        "type": "http",
        "url": "http://localhost:8787/mcp"
      }
    }
  }
  ```
- **Cursor** — same config under MCP servers.
- **MCP Inspector** — point at `http://localhost:8787/mcp` to call tools interactively.
- Any other MCP client supporting streamable HTTP.

---

## Project layout

```
Eyes-MCP/
├── src/
│   ├── index.ts          ← HTTP server, /health, /mcp, signal handling (THIS SUBAGENT)
│   ├── health.ts         ← dependency probe (THIS SUBAGENT)
│   ├── util/logger.ts    ← winston logger (THIS SUBAGENT)
│   ├── tools/            ← MCP tool registration (subagent B)
│   ├── main-agent/       ← orchestrator + LLM client  (subagent B)
│   ├── llm/              ← Gemini/Gemma client         (subagent B)
│   ├── dispatcher/       ← shard fan-out + scheduling  (subagent B)
│   ├── adapters/         ← GitHub/Reddit/YouTube/etc.  (subagent C)
│   └── parse/            ← bloat strip + chunking      (subagent C)
├── searxng/              ← SearXNG config
├── data/                 ← runtime artifacts (gitignored)
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── LICENSE               ← MIT
└── README.md             ← you are here
```

---

## Status

✅ **v0.1.0** — research MCP server, CLI, 10 source adapters, Google AI Studio + OpenRouter providers, full vitest suite (64/64 passing).

See [`03-architecture-main-and-swarm.md`](./03-architecture-main-and-swarm.md) for the design rationale and [`00-brief.md`](./00-brief.md) for the one-liner.

---

## License

MIT. See [LICENSE](./LICENSE).
