// =============================================================================
// Eyes-CLI — `eyes doctor`
//
// Runs diagnostics against the local environment:
//   * config file is readable
//   * the env vars we'd prefer to see are set
//   * searxng + crawl4ai respond
//   * if an LLM is configured, a tiny `generate("ping")` works
//
// Returns process exit 1 if any critical check fails, 0 otherwise.
// Critical = config unreadable, or the LLM was configured but unreachable.
// We intentionally don't fail on missing searxng/crawl4ai (they're optional
// in dev — the agent can still run in heuristic mode).
// =============================================================================

import { request } from "undici";
import { OpenAICompatibleClient, PROVIDERS, getProvider } from "../llm/gemini.js";
import { loadConfig, getConfigPath } from "./config.js";
import { dimRed, error, header, neon, okMark, failMark, success } from "./style.js";

export interface DoctorFlags {
  reveal?: boolean;
  json?: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

export async function doctor(flags: DoctorFlags = {}): Promise<number> {
  void flags;
  const path = getConfigPath();
  const checks: Check[] = [];

  // -- config file ---------------------------------------------------------
  const cfg = await loadConfig(path).catch((err: unknown) => {
    return { __error: err instanceof Error ? err.message : String(err) } as unknown as ReturnType<typeof loadConfig>;
  });
  if ("__error" in cfg) {
    checks.push({ name: "config", ok: false, detail: String(cfg.__error), critical: true });
  } else {
    checks.push({ name: "config", ok: true, detail: path, critical: true });
  }

  // -- env vars (informational, not critical) -----------------------------
  const envChecks: ReadonlyArray<[string, boolean]> = [
    ["GOOGLE_AI_STUDIO_API_KEY", !!process.env["GOOGLE_AI_STUDIO_API_KEY"] || !!process.env["GEMINI_API_KEY"]],
    ["OPENROUTER_API_KEY", !!process.env["OPENROUTER_API_KEY"]],
    ["GITHUB_TOKEN", !!process.env["GITHUB_TOKEN"]],
    ["REDDIT_CLIENT_ID", !!process.env["REDDIT_CLIENT_ID"]],
    ["SEARXNG_URL", !!process.env["SEARXNG_URL"]],
    ["CRAWL4AI_URL", !!process.env["CRAWL4AI_URL"]],
  ];
  for (const [name, set] of envChecks) {
    checks.push({
      name: `env ${name}`,
      ok: true, // not critical either way
      detail: set ? "set" : "unset",
      critical: false,
    });
  }

  // -- searxng + crawl4ai probes (parallel) -------------------------------
  const searxngUrl = (cfg && "searxng" in cfg ? cfg.searxng.url : process.env["SEARXNG_URL"]) ?? "http://searxng:8080";
  const crawl4aiUrl = (cfg && "crawl4ai" in cfg ? cfg.crawl4ai.url : process.env["CRAWL4AI_URL"]) ?? "http://crawl4ai:11235";
  const [searxngOk, crawl4aiOk] = await Promise.all([probe(`${searxngUrl}/healthz`), probe(`${crawl4aiUrl}/health`)]);
  checks.push({
    name: "searxng",
    ok: searxngOk.ok,
    detail: searxngOk.ok ? `${searxngUrl} (${searxngOk.latencyMs}ms)` : `unreachable: ${searxngOk.error}`,
    critical: false,
  });
  checks.push({
    name: "crawl4ai",
    ok: crawl4aiOk.ok,
    detail: crawl4aiOk.ok ? `${crawl4aiUrl} (${crawl4aiOk.latencyMs}ms)` : `unreachable: ${crawl4aiOk.error}`,
    critical: false,
  });

  // -- LLM (if configured) -------------------------------------------------
  if (cfg && "providers" in cfg) {
    const active = getProvider(cfg.providers.active);
    const apiKey = active
      ? active.id === "google-ai-studio"
        ? cfg.provider_google_ai_studio.apiKey
        : cfg.provider_openrouter.apiKey
      : "";
    if (active && apiKey) {
      try {
        const llm = new OpenAICompatibleClient({
          provider: active,
          apiKey,
          model: cfg.providers.model,
        });
        const t0 = Date.now();
        await llm.generate("ping", { maxTokens: 5 });
        checks.push({
          name: `llm (${active.id})`,
          ok: true,
          detail: `${cfg.providers.model} responded in ${Date.now() - t0}ms`,
          critical: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          name: `llm (${active?.id ?? cfg.providers.active})`,
          ok: false,
          detail: msg,
          critical: true,
        });
      }
    } else {
      checks.push({
        name: "llm",
        ok: true,
        detail: `not configured (heuristic mode) — set EYES_PROVIDER + an API key, or run 'eyes models pick'`,
        critical: false,
      });
    }
  } else {
    checks.push({ name: "llm", ok: true, detail: "not configured (heuristic mode)", critical: false });
  }

  // Render one extra info line for the provider catalog.
  const catalog = PROVIDERS.map((p) => `${p.id} (${p.freeModels.length} free models)`).join(", ");
  process.stdout.write(dimRed(`  providers: ${catalog}\n`));

  // -- render --------------------------------------------------------------
  process.stdout.write(header("doctor") + "\n\n");
  for (const c of checks) {
    const mark = c.ok ? okMark() : failMark();
    const tag = c.critical ? neon(c.name) : dimRed(c.name);
    process.stdout.write(`  ${mark} ${tag.padEnd(28)} ${c.detail}\n`);
  }
  process.stdout.write("\n");
  const criticalFails = checks.filter((c) => c.critical && !c.ok);
  if (criticalFails.length > 0) {
    process.stdout.write(error(`${criticalFails.length} critical check(s) failed`) + "\n");
    return 1;
  }
  process.stdout.write(success("all critical checks passed") + "\n");
  return 0;
}

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error: string;
}

async function probe(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    await res.body.dump();
    const ok = res.statusCode >= 200 && res.statusCode < 500;
    return { ok, latencyMs: Date.now() - t0, error: ok ? "" : `status ${res.statusCode}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

