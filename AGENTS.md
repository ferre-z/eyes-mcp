# AGENTS.md — Eyes-MCP

## Build & verify

- `npm run build` — compile TypeScript to `dist/`.
- `npm run dev` — run the server with `tsx watch` (uses `.env` via dotenv).
- `npm run test` — run vitest once.
- `npm run lint` — **typecheck only** (`tsc --noEmit`). There is no ESLint or Prettier config.

## Running the CLI

- `npm run eyes` — run the CLI directly via tsx; no build step needed.
- `bin/eyes.mjs` — production CLI shim; requires `npm run build` first because it imports `dist/cli/index.js`.
- The `eyes` command that end users install is dropped by `scripts/install.sh` / `install.ps1`; it is not the same as `npm run eyes`.

## Running the server

- `npm run dev` starts the MCP HTTP server locally.
- `docker compose up` brings up the full stack: `eyes-mcp`, SearXNG, Redis, Crawl4AI.
- Container listens on `8787` internally; the installer scripts map host port `51823` (override with `EYES_PORT`) to container port `8787`.

## Architecture facts

- One LLM in the system (`src/main-agent/`). It decomposes the prompt, dispatches parallel source adapters, parses results, reviews, and synthesizes.
- Adapters are no-LLM async fetchers. They write raw artifacts to `{EYES_DATA_DIR}/shards/{shardId}.json`; the parse layer reads those files; the main agent never sees raw bytes.
- Streamable HTTP MCP with **per-session** `McpServer` + `StreamableHTTPServerTransport` pairs (multi-tenant). The server must connect the transport before handling requests (`src/index.ts:116`).
- Dispatcher source categories: `web`, `github`, `reddit`, `youtube`, `hackernews`, `arxiv`, `wikipedia`. `osm` and `generic` adapters exist but currently map to `web`.

## Configuration

  - CLI reads a TOML file at `~/.config/eyes/config.toml` (XDG-aware via `XDG_CONFIG_HOME`), parsed by `smol-toml`.
  - The Docker server reads env vars only (`.env` or `docker-compose.yml`); it does not read the TOML.
  - Env always overrides file config. Legacy `GEMINI_API_KEY` still maps onto Google AI Studio.
  - Provider ids are `google-ai-studio` and `openrouter`.
  - Per-session rate limiting is intentionally not implemented in v0.1; it is deferred to v0.2.

## Code conventions

- ESM with `NodeNext` module resolution. Imports must use `.js` extensions (e.g. `./logger.js`) even for `.ts` source files.
- Strict TypeScript with `noUncheckedIndexedAccess` enabled.
- Tests are colocated in `__tests__/` directories and excluded from `tsconfig.json` (`**/*.test.ts`).

## Common gotchas

- `npm run lint` will not catch style issues; it only typechecks.
- After editing TS source, rebuild before the `bin/eyes.mjs` shim reflects changes.
- `docker-compose.yml` publishes SearXNG on host `8080` and Crawl4AI on host `11235`; change those mappings if the ports are already taken.
- The repo has root-level design docs (`00-brief.md`, `03-architecture-main-and-swarm.md`, etc.) but they are not executable; trust `package.json`, `docker-compose.yml`, and source code when they conflict.
