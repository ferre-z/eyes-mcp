// =============================================================================
// Eyes-CLI — config layer
//
// Backed by a hand-rolled TOML file at $EYES_CONFIG or, by default,
// $XDG_CONFIG_HOME/eyes/config.toml (falling back to ~/.config/eyes/config.toml).
// We don't add a TOML dep — the schema is small and stable enough to do by
// hand. Each section is `[section]\n` lines; values are unquoted strings,
// quoted strings, numbers, or booleans.
//
// On read, missing keys fall back to defaults; on write, the whole file is
// rewritten (full-file replace — no partials).
//
// Env overrides for secrets always win: GEMINI_API_KEY, GITHUB_TOKEN,
// REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, etc.
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface EyesConfig {
  server: {
    host: string;
    port: number;
    logLevel: string;
  };
  /** Which LLM provider to use. One of the entries in src/llm/gemini.ts. */
  providers: {
    active: "google-ai-studio" | "openrouter";
    model: string;
  };
  /** API key for the Google AI Studio provider. Empty = not set. */
  provider_google_ai_studio: {
    apiKey: string;
  };
  /** API key for the OpenRouter provider. Empty = not set. */
  provider_openrouter: {
    apiKey: string;
  };
  sources: {
    githubToken: string;
    redditClientId: string;
    redditClientSecret: string;
  };
  agents: {
    maxShards: number;
    maxIterations: number;
    tokenBudget: number;
    timeBudgetSec: number;
    defaultDepth: "quick" | "standard" | "deep";
    /** How long a previously written shard artifact is reused instead of re-fetching. */
    shardCacheTtlMs: number;
  };
  searxng: { url: string };
  crawl4ai: { url: string };
}

export const DEFAULTS: EyesConfig = {
  server: { host: "0.0.0.0", port: 8787, logLevel: "info" },
  providers: { active: "google-ai-studio", model: "gemma-4-31b-it" },
  provider_google_ai_studio: { apiKey: "" },
  provider_openrouter: { apiKey: "" },
  sources: { githubToken: "", redditClientId: "", redditClientSecret: "" },
  agents: {
    maxShards: 5,
    maxIterations: 2,
    tokenBudget: 80_000,
    timeBudgetSec: 120,
    defaultDepth: "standard",
    shardCacheTtlMs: 60_000,
  },
  searxng: { url: "http://localhost:8080" },
  crawl4ai: { url: "http://localhost:11235" },
};

/** Keys whose values must not be printed unless `--reveal` is passed. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "provider_google_ai_studio.apiKey",
  "provider_openrouter.apiKey",
  "sources.githubToken",
  "sources.redditClientId",
  "sources.redditClientSecret",
]);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function getConfigPath(): string {
  const envPath = process.env["EYES_CONFIG"];
  if (envPath && envPath.length > 0) return envPath;
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "eyes", "config.toml");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function loadConfig(p?: string): Promise<EyesConfig> {
  const filePath = p ?? getConfigPath();
  let fromFile: Partial<EyesConfig> = {};
  if (existsSync(filePath)) {
    const raw = await readFile(filePath, "utf8");
    fromFile = parseToml(raw);
  }
  // Back-compat: a v0.1 config file had `[llm]` instead of the new
  // `[providers]` + `[provider_*]` sections. Migrate it on read.
  migrateLegacy(fromFile);
  const merged: EyesConfig = mergeDeep(structuredClone(DEFAULTS), fromFile as EyesConfig);
  // Env wins for secrets and the most common operational knobs.
  applyEnvOverrides(merged);
  return merged;
}

function migrateLegacy(raw: Record<string, unknown>): void {
  const legacy = raw["llm"] as Record<string, unknown> | undefined;
  if (!legacy) return;
  const providers = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
  if (!providers["active"] && typeof legacy["provider"] === "string") {
    if (legacy["provider"] === "gemini") providers["active"] = "google-ai-studio";
    else if (legacy["provider"] === "openai") providers["active"] = "openrouter";
  }
  if (!providers["model"] && typeof legacy["model"] === "string") {
    providers["model"] = legacy["model"];
  }
  raw["providers"] = providers;
  // Migrate the old apiKey into the new section, prefer google-ai-studio.
  if (typeof legacy["apiKey"] === "string" && legacy["apiKey"].length > 0) {
    const g = (raw["provider_google_ai_studio"] as Record<string, unknown> | undefined) ?? {};
    if (!g["apiKey"]) g["apiKey"] = legacy["apiKey"];
    raw["provider_google_ai_studio"] = g;
  }
  // Drop the old key so mergeDeep doesn't try to copy `llm` into DEFAULTS.
  delete raw["llm"];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function saveConfig(cfg: EyesConfig, p?: string): Promise<void> {
  const filePath = p ?? getConfigPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const toml = serializeToml(cfg);
  await writeFile(filePath, toml, "utf8");
}

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------

/** Return a section by key. */
export function get<K extends keyof EyesConfig>(cfg: EyesConfig, key: K): EyesConfig[K] {
  return cfg[key];
}

/**
 * Parse "section.key" style, coerce to the right type, persist, return
 * the updated value. Throws on unknown keys or invalid values.
 */
export async function setKey(
  cfg: EyesConfig,
  dottedKey: string,
  rawValue: string,
  p?: string,
): Promise<{ section: string; key: string; value: string | number | boolean }> {
  const [section, key] = dottedKey.split(".");
  if (!section || !key) {
    throw new Error(`invalid key "${dottedKey}" — expected "section.key"`);
  }
  const sectionObj = (cfg as unknown as Record<string, Record<string, unknown>>)[section];
  if (!sectionObj || typeof sectionObj !== "object") {
    throw new Error(`unknown section "${section}"`);
  }
  if (!(key in sectionObj)) {
    throw new Error(`unknown key "${section}.${key}"`);
  }
  const current = sectionObj[key];
  const coerced = coerce(rawValue, current);
  sectionObj[key] = coerced;
  await saveConfig(cfg, p);
  return { section, key, value: coerced as string | number | boolean };
}

// ---------------------------------------------------------------------------
// Env overrides
// ---------------------------------------------------------------------------

function applyEnvOverrides(cfg: EyesConfig): void {
  const map: ReadonlyArray<[string, () => void]> = [
    [
      "GOOGLE_AI_STUDIO_API_KEY",
      () => {
        const v = process.env["GOOGLE_AI_STUDIO_API_KEY"];
        if (v && v.length > 0) cfg.provider_google_ai_studio.apiKey = v;
      },
    ],
    [
      "OPENROUTER_API_KEY",
      () => {
        const v = process.env["OPENROUTER_API_KEY"];
        if (v && v.length > 0) cfg.provider_openrouter.apiKey = v;
      },
    ],
    // Back-compat: legacy GEMINI_* vars still work and map onto the new section.
    [
      "GEMINI_API_KEY",
      () => {
        const v = process.env["GEMINI_API_KEY"];
        if (v && v.length > 0) cfg.provider_google_ai_studio.apiKey = v;
      },
    ],
    [
      "EYES_PROVIDER",
      () => {
        const v = process.env["EYES_PROVIDER"];
        if (v === "google-ai-studio" || v === "openrouter") cfg.providers.active = v;
      },
    ],
    [
      "EYES_MODEL",
      () => {
        const v = process.env["EYES_MODEL"];
        if (v && v.length > 0) cfg.providers.model = v;
      },
    ],
    [
      "GITHUB_TOKEN",
      () => {
        const v = process.env["GITHUB_TOKEN"];
        if (v && v.length > 0) cfg.sources.githubToken = v;
      },
    ],
    [
      "REDDIT_CLIENT_ID",
      () => {
        const v = process.env["REDDIT_CLIENT_ID"];
        if (v && v.length > 0) cfg.sources.redditClientId = v;
      },
    ],
    [
      "REDDIT_CLIENT_SECRET",
      () => {
        const v = process.env["REDDIT_CLIENT_SECRET"];
        if (v && v.length > 0) cfg.sources.redditClientSecret = v;
      },
    ],
    [
      "SEARXNG_URL",
      () => {
        const v = process.env["SEARXNG_URL"];
        if (v && v.length > 0) cfg.searxng.url = v;
      },
    ],
    [
      "CRAWL4AI_URL",
      () => {
        const v = process.env["CRAWL4AI_URL"];
        if (v && v.length > 0) cfg.crawl4ai.url = v;
      },
    ],
    [
      "EYES_HTTP_HOST",
      () => {
        const v = process.env["EYES_HTTP_HOST"];
        if (v && v.length > 0) cfg.server.host = v;
      },
    ],
    [
      "EYES_HTTP_PORT",
      () => {
        const v = process.env["EYES_HTTP_PORT"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.server.port = n;
        }
      },
    ],
    [
      "EYES_LOG_LEVEL",
      () => {
        const v = process.env["EYES_LOG_LEVEL"];
        if (v && v.length > 0) cfg.server.logLevel = v;
      },
    ],
    [
      "EYES_MAX_SHARDS",
      () => {
        const v = process.env["EYES_MAX_SHARDS"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.agents.maxShards = n;
        }
      },
    ],
    [
      "EYES_MAX_ITERATIONS",
      () => {
        const v = process.env["EYES_MAX_ITERATIONS"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.agents.maxIterations = n;
        }
      },
    ],
    [
      "EYES_TOKEN_BUDGET",
      () => {
        const v = process.env["EYES_TOKEN_BUDGET"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.agents.tokenBudget = n;
        }
      },
    ],
    [
      "EYES_TIME_BUDGET_SEC",
      () => {
        const v = process.env["EYES_TIME_BUDGET_SEC"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.agents.timeBudgetSec = n;
        }
      },
    ],
    [
      "EYES_SHARD_CACHE_TTL_MS",
      () => {
        const v = process.env["EYES_SHARD_CACHE_TTL_MS"];
        if (v && v.length > 0) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) cfg.agents.shardCacheTtlMs = n;
        }
      },
    ],
  ];
  for (const [, apply] of map) apply();
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function coerce(raw: string, current: unknown): string | number | boolean {
  if (typeof current === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected number, got "${raw}"`);
    return n;
  }
  if (typeof current === "boolean") {
    if (raw === "true" || raw === "1" || raw === "yes") return true;
    if (raw === "false" || raw === "0" || raw === "no") return false;
    throw new Error(`expected boolean, got "${raw}"`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Merge (one level deep, per section)
// ---------------------------------------------------------------------------

function mergeDeep(base: EyesConfig, override: EyesConfig): EyesConfig {
  const out: EyesConfig = structuredClone(base);
  for (const k of Object.keys(override) as Array<keyof EyesConfig>) {
    const o = override[k] as Record<string, unknown>;
    const b = out[k] as Record<string, unknown>;
    for (const kk of Object.keys(o)) {
      if (o[kk] !== undefined) b[kk] = o[kk];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hand-rolled TOML
// ---------------------------------------------------------------------------
//
// Supports only what we write: top-level tables, scalar values (string,
// number, boolean). We never write arrays or nested tables, so we don't
// need to parse them. Strings are bare or double-quoted; double-quoted
// strings escape `\\` and `"`. Numbers are integers. Booleans are `true`/
// `false`. Comments start with `#`. Blank lines are ignored.
// ---------------------------------------------------------------------------

function serializeToml(cfg: EyesConfig): string {
  const lines: string[] = ["# Generated by eyes init. Edit freely — section.key format."];
  const sections = Object.keys(cfg) as Array<keyof EyesConfig>;
  for (const s of sections) {
    lines.push(`[${s}]`);
    const obj = cfg[s] as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      lines.push(`${k} = ${tomlValue(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function tomlValue(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    // Quote anything that isn't a safe bareword.
    if (/^[A-Za-z0-9_\-\.\/]+$/.test(v)) return v;
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  // Shouldn't happen — fall back to quoted JSON.
  return `"${JSON.stringify(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseToml(raw: string): Partial<EyesConfig> {
  const out: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const tableMatch = /^\[([A-Za-z0-9_]+)\]$/.exec(line);
    if (tableMatch) {
      const name = tableMatch[1]!;
      out[name] = out[name] ?? {};
      current = out[name]!;
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1]!;
    const rawVal = kvMatch[2]!.trim();
    const value = parseTomlValue(rawVal);
    if (current) current[key] = value;
  }
  return out as Partial<EyesConfig>;
}

function parseTomlValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const n = Number(raw);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  return raw;
}
