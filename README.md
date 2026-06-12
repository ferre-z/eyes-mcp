# Eyes-MCP

**The research MCP for AI agents. One-line install. Zero required keys. Arrow-key setup.**

```
curl -sSL https://raw.githubusercontent.com/ferre-z/eyes-mcp/main/scripts/install.sh | bash
```

Then:

```
eyes setup
```

That's it. The wizard detects your tools, asks a few questions, writes your config, starts the container, and patches your agent's MCP config to point at it.

---

## What you get

A small service that your AI agent (opencode, Claude, Cursor, Continue, …) calls when it needs to look something up. The service fans your question out across SearXNG, Crawl4AI, GitHub, Reddit, YouTube, Hacker News, and arXiv, parses the results, and returns a synthesized answer with citations.

You can run it with **no API keys** (heuristic mode, free) or with a free-tier LLM key (Google AI Studio / OpenRouter, both free).

## What it looks like

```
┌  eyes setup
│
◇  ✓ environment detected

  ✓  docker      v29.5.3
  ✓  opencode    /home/you/.config/opencode/config.json
  ✓  Cursor      /home/you/.config/Cursor/mcp.json

◇  which LLM do you want?
│  ● Heuristic only (no key, free)
│  ○ google-ai-studio (free tier)
│  ○ openrouter       (free tier)
└
◇  port?
│  51823
└
◇  bind address
│  ● loopback only (127.0.0.1)
│  ○ all interfaces (0.0.0.0)
└
◇  which tools should auto-connect to eyes-mcp?
│  ◼ opencode
│  ◼ Cursor
│  ☐ Continue
└

▸ plan
  config     /home/you/.config/eyes/config.toml
  server     127.0.0.1:51823
  llm        heuristic (no key)
  container  ✓ docker
  tools      opencode, Cursor

✓ wrote /home/you/.config/eyes/config.toml
✓ patched 2 tool configs
✓ eyes-mcp is running

╭─ ready ─────────────────────────────────────────╮
│ ▸ MCP endpoint: http://127.0.0.1:51823/mcp      │
│ ▸ Health check:  http://127.0.0.1:51823/health  │
│                                                  │
│ Connect your tools:                              │
│   • opencode    auto-detected, restart it        │
│   • Cursor      Settings → MCP → add server      │
│                                                  │
│ Try it:                                          │
│   eyes "what's the latest on gemma 4 31b?"       │
╰──────────────────────────────────────────────────╯

✓ eyes-mcp is ready
```

## Install

### macOS / Linux

```bash
curl -sSL https://raw.githubusercontent.com/ferre-z/eyes-mcp/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/ferre-z/eyes-mcp/main/scripts/install.ps1 | iex
```

The installer:

1. Verifies Docker is installed (or tells you to install Docker Desktop)
2. Pulls the image from `ghcr.io/ferre-z/eyes-mcp:0.1.0`
3. Starts the container in the background
4. Installs a small `eyes` CLI shim to `~/.local/bin` and warns if it's not on PATH
5. Prints a one-screen "you're done" summary

**Customize:**

```bash
# Pick a different port
EYES_PORT=51999 curl -sSL ... | bash

# Pin to a specific image (CI, internal mirror, …)
EYES_IMAGE=ghcr.io/your-org/eyes-mcp:custom curl -sSL ... | bash
```

## First-time setup

```bash
eyes setup
```

The wizard walks you through: LLM provider, server port, bind address, and which tools to auto-patch. Re-run any time to change settings.

## Daily use

```bash
eyes "what's the latest on gemma 4 31b?"        # one-shot research
eyes chat "compare bun and deno" --depth deep   # deep research, more sources
eyes doctor                                    # is everything healthy?
eyes logs                                      # tail the container logs
eyes stop / start / restart                    # container control
eyes upgrade                                   # pull a new image and restart
eyes models pick                               # change your LLM key
eyes setup                                     # re-run the wizard
```

## What it does

```
Caller (opencode / Claude / Cursor / …)
   │
   │  "what's the latest on gemma 4 31b?"
   ▼
┌──────────────────────────────────────────────┐
│              eyes-mcp (the wizard's product) │
│                                              │
│  Main agent  ── 1. Decompose question        │
│     │                                        │
│     ├─→ 2. Dispatch N parallel sub-agents    │
│     │     │                                  │
│     │     ├─ SearXNG     ──┐                 │
│     │     ├─ GitHub API  ──┤                 │
│     │     ├─ Reddit      ──┤                 │
│     │     ├─ YouTube     ──┤                 │
│     │     ├─ Hacker News ──┤                 │
│     │     └─ arXiv       ──┘                 │
│     │                                        │
│     ├─→ 3. Parse (strip HTML, chunk, dedupe) │
│     │                                        │
│     └─→ 4. Review & synthesize → answer      │
│                                              │
└──────────────────────────────────────────────┘
   │
   ▼
"Based on… [gemma 4 model card on ai.google.dev]…"
```

Each sub-agent is a no-LLM async coroutine that writes its raw output to disk. The main agent (only one LLM in the system) reads the chunks, not the raw HTML, so context stays bounded. See [`docs/03-architecture-main-and-swarm.md`](./docs/03-architecture-main-and-swarm.md) for the full design.

## Why this exists

There are 5+ "SearXNG + Crawl4AI + MCP" wrappers already. This one is different:

| | |
|---|---|
| **Zero-friction install** | `curl \| bash` works with no API keys. The wizard never asks you to log into a portal mid-flow. |
| **Arrow-key setup** | `eyes setup` is a single flow with @clack/prompts. No YAML to hand-edit, no env files to read. |
| **Tool auto-connect** | Detects opencode / Cursor / Claude Desktop / Continue on first run. Patches their `mcpServers` config in place. |
| **Multi-tenant** | Streamable HTTP, stateful sessions. Designed to be a shared service, not a personal daemon. |
| **No required keys** | Runs in heuristic mode with zero secrets. LLM is an optional upgrade for smarter synthesis. |
| **Source-aware** | GitHub, Reddit, YouTube, arXiv each have a dedicated adapter, not a generic search-then-scrape path. |

## Configuration

The CLI reads `~/.config/eyes/config.toml` (XDG-aware). The Docker server reads env vars. See [`.env.example`](./.env.example) for the full list. Highlights:

| Section | Key | Default | Notes |
|---|---|---|---|
| `server` | `host` | `0.0.0.0` | `127.0.0.1` for loopback only |
| `server` | `port` | `51823` | any free port |
| `providers` | `active` | `google-ai-studio` | or `openrouter` |
| `providers` | `model` | `gemma-4-31b-it` | any model the provider supports |
| `provider_google_ai_studio` | `apiKey` | _(empty)_ | heuristic mode if unset |
| `agents` | `defaultDepth` | `standard` | `quick` / `standard` / `deep` |
| `agents` | `maxShards` | `5` | cap of 20 |
| `agents` | `maxIterations` | `2` | cap of 5 |

## Project layout

```
Eyes-MCP/
├── src/
│   ├── index.ts          ← Streamable HTTP server, /health, /mcp
│   ├── main-agent/       ← The only LLM — decompose / review / synthesize
│   ├── llm/              ← OpenAI-compatible client (Gemini + OpenRouter)
│   ├── dispatcher/       ← Parallel sub-agent fan-out
│   ├── adapters/         ← 10 source adapters (SearXNG, GitHub, Reddit, …)
│   ├── parse/            ← HTML strip, chunk, simhash dedupe
│   ├── cli/              ← `eyes` CLI: setup, init, doctor, models, chat, …
│   └── tools/            ← MCP tool registration
├── scripts/
│   ├── install.sh        ← macOS / Linux one-liner
│   └── install.ps1       ← Windows one-liner
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md             ← you are here
```

## Troubleshooting

```bash
eyes doctor           # shows config + container + LLM status, with fix hints
docker logs eyes      # raw container logs
eyes logs             # same, but with the right container name
```

Common issues:

| Symptom | Fix |
|---|---|
| `port 51823 in use` | `EYES_PORT=51999 bash …` the installer |
| `docker not found` | install Docker Desktop, re-run |
| `mcpServers.eyes not seen` | restart the tool (opencode, Cursor, …) |
| `LLM HTTP 401/403` | `eyes models pick` and re-paste a valid key |
| `connection refused` after install | `docker ps` — is the container running? |

## License

MIT. See [LICENSE](./LICENSE).
