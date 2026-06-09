# Eyes-MCP — opencode test prompt

> Drop this into opencode as a message, or save it as `Eyes-MCP-test.md` in a folder opencode watches, and tell opencode to act on it. Assumes you cloned and started the container (see `README.md`), and that opencode is on the same machine as the container (or you have a Tailscale route / SSH tunnel — see "Remote box" at the bottom).

The container is bound to **`0.0.0.0:51823`** on the orius server, so if you're on the same Tailscale network as orius, you don't need an SSH tunnel — opencode can talk to it directly.

---

## Goal

You have a research tool called **Eyes-MCP** exposed at `http://127.0.0.1:51823/mcp`. Verify it works end-to-end: discover its tools, run a real research query through it, and check the output is useful.

## What "works" means

1. opencode can talk to the MCP server (no timeouts, no `Server already initialized`).
2. The server exposes exactly two tools: `research` and `ping`.
3. The `research` tool returns a structured response with shards, citations, and a synthesized answer.
4. The answer is grounded in the sources — every claim should trace to a specific URL or shard.

## What to do

### Step 1 — health check

```bash
curl -s http://100.93.242.126:51823/health
```

Expected: `{"status":"ok",...}`. If it hangs, the container is not up — re-run the docker compose / docker run command from the README.

### Step 2 — discover the MCP tools

In opencode, ask:

```
List the tools exposed by the eyes MCP server.
```

(How exactly to phrase this depends on your opencode version. If opencode doesn't auto-list MCP tools, the equivalent is `tools/list` against `http://127.0.0.1:51823/mcp`.)

Expected: `research` and `ping`.

### Step 3 — sanity ping

Ask opencode:

```
Use the eyes MCP's ping tool.
```

Expected: it returns the string `pong`.

### Step 4 — the real test

Ask opencode:

```
Use the eyes research tool to answer: "what is gemma 4 31b and what can it do?"
Use depth=standard, maxShards=4, maxIterations=2.
```

Wait for the response. It should be a JSON-ish blob with:
- `answer`: a short synthesized text
- `shards`: a list of 4 sub-questions the main agent decomposed your prompt into
- per-shard `ok: true` and `chunkCount` > 0 where it found content
- `mode: "heuristic"` if you haven't set an LLM key, or `mode: "llm"` if you have
- `durationMs` — typically 500ms–3s in heuristic mode, 2–15s in LLM mode

### Step 5 — the harder test

Once Step 4 works, try a multi-source prompt:

```
Use eyes to compare bun and deno for scripting. Search github, hackernews, and arxiv at minimum.
```

Expected shards: 3–5, mostly `ok: true`.

### Step 6 — failure mode (good to see)

Ask:

```
Use eyes to find the latest tweets from a Twitter user.
```

Expected: 1+ shard with `ok: false` and an error like "X/Twitter not configured" or similar. The research still completes; the main agent just synthesizes from whatever did work.

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` on 51823 | container not running | `docker ps --filter label=app=eyes`; restart if absent |
| `curl` hangs forever | container up but server stuck | `docker logs eyes` for the error |
| `tools/list` returns nothing | opencode using wrong URL | check `mcpServers.eyes.url` in opencode's config |
| `research` returns "LLM HTTP 401" | bad API key | re-run `eyes models pick` and paste a real `AIzaSy...` key from https://aistudio.google.com/apikey |
| `research` hangs > 30s | a single source is slow | expected; it has a 30s timeout per shard. Lower `maxShards` to 3 to speed it up |
| answer is just "no data" | heuristic mode + no live sources | install a key, OR start the stack with `searxng` + `crawl4ai` reachable |

## What success looks like

- Opencode shows the eyes tool in its MCP tool list.
- The research tool runs in 1–10s and returns structured output.
- The answer text is grounded in the shards (you can see the per-source summaries in the `shards` field).
- You can paste a specific shard's URL into a browser and verify the content.

## What to report back

When you tell me it works, include:
1. Which query you tested
2. Mode: heuristic or LLM
3. Number of shards and how many succeeded
4. The synthesized answer (paste it)
5. Total duration
6. Anything weird (timeout, weird output, missing shards)

If it doesn't work, paste the exact error and the `docker logs eyes` output.

---

## Remote box (optional)

If the docker stack is on a different machine (the `orius` server) and opencode is on your laptop:

```bash
# Forward the eyes port to your laptop
ssh -N -L 51823:127.0.0.1:51823 orius
```

Then opencode on your laptop points at `http://127.0.0.1:51823/mcp` exactly the same way — the SSH tunnel makes localhost on your laptop look like localhost on the server.

The same trick works for `searxng` (8080) and `crawl4ai` (11235) if you want to poke at them directly, but you don't need to — eyes on the same Docker network already talks to them.

## Optional: opencode MCP config snippet

```json
{
  "mcpServers": {
    "eyes": {
      "type": "http",
      "url": "http://100.93.242.126:51823/mcp"
    }
  }
}
```

Drop this into opencode's config (location depends on your opencode version — usually `~/.config/opencode/config.json` or via the opencode UI's MCP server dialog), then restart opencode.
