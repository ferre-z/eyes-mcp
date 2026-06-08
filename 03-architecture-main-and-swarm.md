# Architecture — main agent + swarm (v2)

## The flow
```
caller
  │  JSON: { prompt, depth, max_shards, ... }
  ▼
[main agent] ← the only LLM
  │ 1. reads available sources
  │ 2. decomposes prompt → N sub-tasks (shards)
  │ 3. each shard = one theme/angle
  ▼
[N sub-agents] ← async coroutines (no LLM)
  │ each shard runs:
  │   - search (SearXNG / GitHub / Reddit / YouTube / ...)
  │   - fetch (Crawl4AI / API call)
  │   - write raw output to disk (artifact pattern)
  │   - return: shard_id + path_to_raw
  ▼
[parse layer 1] ← pure script, no LLM
  │ per shard:
  │   - strip bloat (HTML, nav, ads, boilerplate)
  │   - depth param controls how aggressive the strip is
  ▼
[parse layer 2] ← pure script, no LLM
  │ per shard:
  │   - chunk text (per-theme = per-shard, no re-clustering)
  │   - dedup within shard
  │   - cap chunk count per shard
  ▼
[main agent] ← reviews { shard_id: [chunks] }
  │ decides:
  │   → return synthesized answer to caller
  │   → loop: spawn more shards to fill gaps
  ▼
caller
```

## Decisions locked
- **Only the main agent is an LLM.** Sub-agents = async coroutines.
- **Sub-agents write raw output to disk.** Main agent sees pointers + chunks, not raw.
- **Parse layer 1 = bloat strip.** Aggressiveness driven by `depth` param.
- **No ranking.** Every chunk goes to the main agent.
- **Themes = shards.** Main agent's decomposition defines the themes. Chunks are grouped by shard_id. No second clustering pass.
- **Crawl4AI's output is trusted** for URL-fetched content — don't re-strip.

## Caller input schema (v0)
```json
{
  "prompt":      "string, required, the research question",
  "depth":       "quick | standard | deep, default standard",
  "max_shards":  "int, default 5, cap 20",
  "max_iterations": "int, default 2, cap 5",
  "scope":       "array of source categories, default ['general']",
  "output_format": "markdown | json | summary, default markdown"
}
```

## Depth → behavior mapping
| depth | parse layer 1 | parse layer 2 | sub-agent fetch |
|---|---|---|---|
| **quick** | minimal strip | first 20 chunks per shard | top 3 results per source |
| **standard** | normal strip | first 50 chunks per shard | top 5 results per source |
| **deep** | aggressive strip (dedup across shards) | first 100 chunks per shard | top 10 results per source, follow 1 link deep |

## Chunking strategy (my lead, since user said "take the lead")
- **Split by structure first** (headers, paragraphs, code blocks). Then by size cap (~500 tokens).
- **Keep code blocks intact** — never split mid-function.
- **Each chunk gets a metadata header**: `{shard_id, source, url, char_offset, token_count}`.
- **Dedup is per-shard, fingerprint-based** (simhash or shingle hash, no LLM).
- **No cross-shard dedup** — the main agent is the right place to notice "GitHub and Reddit both said X".

## Stop conditions for the refinement loop
1. Main agent says "good enough" (explicit)
2. `max_iterations` hit (caller param, default 2)
3. Token budget hit (env var)
4. Time budget hit (env var, default 120s)

## What I still want to flag (not blocking, but worth knowing)
- **No ranking** means the main agent's context fills up fast. With `max_shards=5` and 50 chunks each = 250 chunks. Need a **soft cap on total chunks** going to the main agent (~200), or we'll blow the context window on iteration 2.
- **Dedup is per-shard only**. Cross-shard dedup is the main agent's job (it can spot "5 shards all mentioned the same release"). That's fine, just explicit.
- **Quick mode** is the escape hatch for "I just want headlines" — useful for cost-sensitive callers.
