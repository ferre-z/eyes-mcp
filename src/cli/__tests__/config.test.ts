// =============================================================================
// Eyes-CLI — config round-trip test
//
// Hand-rolled TOML is the most likely thing to break (escape rules, quote
// handling, type coercion). This test loads → writes → reloads and checks
// the values come back the same.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULTS,
  loadConfig,
  saveConfig,
  setKey,
  getConfigPath,
} from "../config.js";

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "eyes-config-"));
  file = path.join(dir, "config.toml");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config: round-trip", () => {
  it("defaults serialize then deserialize to identical values", async () => {
    await saveConfig(DEFAULTS, file);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("[server]");
    expect(raw).toContain("[providers]");
    expect(raw).toContain("[provider_google_ai_studio]");
    expect(raw).toContain("[provider_openrouter]");
    expect(raw).toContain("port = 8787");
    const reloaded = await loadConfig(file);
    expect(reloaded.server.port).toBe(8787);
    expect(reloaded.agents.maxShards).toBe(5);
    expect(reloaded.providers.model).toBe("gemma-4-31b-it");
    expect(reloaded.providers.active).toBe("google-ai-studio");
  });

  it("quoted strings with special chars survive a round-trip", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.providers.model = 'weird "model" name with /slashes';
    await saveConfig(cfg, file);
    const reloaded = await loadConfig(file);
    expect(reloaded.providers.model).toBe(cfg.providers.model);
  });

  it("setKey on providers.model works", async () => {
    const cfg = await loadConfig(file);
    const r = await setKey(cfg, "providers.model", "llama-3.3-70b", file);
    expect(r.value).toBe("llama-3.3-70b");
    const reloaded = await loadConfig(file);
    expect(reloaded.providers.model).toBe("llama-3.3-70b");
  });

  it("setKey coerces strings to numbers", async () => {
    const cfg = await loadConfig(file);
    const r = await setKey(cfg, "agents.maxShards", "12", file);
    expect(r.value).toBe(12);
  });

  it("setKey rejects unknown section", async () => {
    const cfg = await loadConfig(file);
    await expect(setKey(cfg, "nope.key", "x", file)).rejects.toThrow(/unknown section/);
  });

  it("setKey rejects unknown key", async () => {
    const cfg = await loadConfig(file);
    await expect(setKey(cfg, "server.nope", "x", file)).rejects.toThrow(/unknown key/);
  });

  it("getConfigPath honors EYES_CONFIG env", () => {
    process.env["EYES_CONFIG"] = "/tmp/eyes-test-path.toml";
    expect(getConfigPath()).toBe("/tmp/eyes-test-path.toml");
    delete process.env["EYES_CONFIG"];
  });

  it("missing file yields defaults", async () => {
    const cfg = await loadConfig(path.join(dir, "does-not-exist.toml"));
    expect(cfg.server.port).toBe(DEFAULTS.server.port);
    expect(cfg.agents.maxShards).toBe(DEFAULTS.agents.maxShards);
    expect(cfg.providers.active).toBe("google-ai-studio");
  });
});

describe("config: legacy v0.1 [llm] section migration", () => {
  it("migrates [llm] provider=gemini to providers.active=google-ai-studio", async () => {
    const legacyFile = path.join(dir, "legacy.toml");
    await writeFile(
      legacyFile,
      `[server]
host = "0.0.0.0"
port = 8787
logLevel = "info"

[llm]
provider = "gemini"
apiKey = "sk-legacy-key-1234"
model = "gemma-3-27b-it"
baseUrl = "https://generativelanguage.googleapis.com"

[sources]
githubToken = ""
redditClientId = ""
redditClientSecret = ""

[agents]
maxShards = 5
maxIterations = 2
tokenBudget = 80000
timeBudgetSec = 120
defaultDepth = "standard"

[searxng]
url = "http://x"

[crawl4ai]
url = "http://x"
`,
      "utf8",
    );
    const cfg = await loadConfig(legacyFile);
    expect(cfg.providers.active).toBe("google-ai-studio");
    expect(cfg.providers.model).toBe("gemma-3-27b-it");
    expect(cfg.provider_google_ai_studio.apiKey).toBe("sk-legacy-key-1234");
  });

  it("migrates [llm] provider=openai to providers.active=openrouter", async () => {
    const legacyFile = path.join(dir, "legacy2.toml");
    await writeFile(
      legacyFile,
      `[llm]
provider = "openai"
apiKey = "sk-or-v1-xxx"
model = "gpt-4o-mini"
baseUrl = ""

[sources]
githubToken = ""
redditClientId = ""
redditClientSecret = ""

[agents]
maxShards = 5
maxIterations = 2
tokenBudget = 80000
timeBudgetSec = 120
defaultDepth = "standard"

[searxng]
url = "x"

[crawl4ai]
url = "x"

[server]
host = "0.0.0.0"
port = 8787
logLevel = "info"
`,
      "utf8",
    );
    const cfg = await loadConfig(legacyFile);
    expect(cfg.providers.active).toBe("openrouter");
    expect(cfg.provider_google_ai_studio.apiKey).toBe("sk-or-v1-xxx");
  });
});

describe("config: env overrides for new providers", () => {
  afterEach(() => {
    delete process.env["GOOGLE_AI_STUDIO_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["EYES_PROVIDER"];
    delete process.env["EYES_MODEL"];
  });

  it("GOOGLE_AI_STUDIO_API_KEY sets provider_google_ai_studio.apiKey", async () => {
    process.env["GOOGLE_AI_STUDIO_API_KEY"] = "real-key-abc";
    const cfg = await loadConfig(path.join(dir, "empty.toml"));
    expect(cfg.provider_google_ai_studio.apiKey).toBe("real-key-abc");
  });

  it("OPENROUTER_API_KEY sets provider_openrouter.apiKey", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key-xyz";
    const cfg = await loadConfig(path.join(dir, "empty.toml"));
    expect(cfg.provider_openrouter.apiKey).toBe("or-key-xyz");
  });

  it("EYES_PROVIDER switches the active provider", async () => {
    process.env["EYES_PROVIDER"] = "openrouter";
    const cfg = await loadConfig(path.join(dir, "empty.toml"));
    expect(cfg.providers.active).toBe("openrouter");
  });

  it("EYES_MODEL overrides the model id", async () => {
    process.env["EYES_MODEL"] = "llama-3.3-70b-instruct:free";
    const cfg = await loadConfig(path.join(dir, "empty.toml"));
    expect(cfg.providers.model).toBe("llama-3.3-70b-instruct:free");
  });
});
