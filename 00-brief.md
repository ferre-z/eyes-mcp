# Eyes-MCP — Brief

## What it is
- A **research MCP** for AI agents
- Lives in **Docker** with **Crawl4AI** + **SearXNG** out of the box
- Agents call it with a question + a few params → it does the research
- **Swarm of lightweight sub-agents** split the request and fan out in parallel
- Source-specific adapters: **GitHub, Reddit, YouTube** + general web
- Ships with **proxy support** (SearXNG outbound gets blocked from datacenter IPs)
- This is a **public project** — not just for me. Has to be good

## Core constraints
- Docker-packaged, single `docker compose up` install
- No install-time secrets required (LLM key optional)
- Streamable HTTP transport (not stdio) — designed to be a shared service

---

## Open questions (carried from discussion)
1. Which **differentiator** is the v1 headline? (A: citation-correct / B: zero-friction / C: shared service)
2. Which **sources** are v1? (Tier 1 + which of Tier 2/3/4?)
3. Is the **swarm** v1 or v2? My recommendation: v2, behind a flag
4. **LLM-optional** at v1? My recommendation: yes — two opt-in env vars
