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
    expect(raw).toContain("[llm]");
    expect(raw).toContain('port = 8787');
    const reloaded = await loadConfig(file);
    expect(reloaded.server.port).toBe(8787);
    expect(reloaded.agents.maxShards).toBe(5);
    expect(reloaded.llm.model).toBe("gemma-4-31b-it");
  });

  it("quoted strings with special chars survive a round-trip", async () => {
    const cfg = { ...DEFAULTS };
    cfg.llm.baseUrl = "https://example.com/path with spaces/and\"quotes";
    await saveConfig(cfg, file);
    const reloaded = await loadConfig(file);
    expect(reloaded.llm.baseUrl).toBe(cfg.llm.baseUrl);
  });

  it("boolean coercion: true/yes/1 → true; false/no/0 → false", async () => {
    await writeFile(
      file,
      `[server]\nlogLevel = "info"\n[llm]\nprovider = "gemini"\napiKey = "k"\nmodel = "m"\nbaseUrl = "u"\n[sources]\ngithubToken = ""\nredditClientId = ""\nredditClientSecret = ""\n[agents]\nmaxShards = 5\nmaxIterations = 2\ntokenBudget = 80000\ntimeBudgetSec = 120\ndefaultDepth = "standard"\n[searxng]\nurl = "u"\n[crawl4ai]\nurl = "u"\n`,
      "utf8",
    );
    const cfg = await loadConfig(file);
    const r1 = await setKey(cfg, "server.port", "1234", file);
    expect(r1.value).toBe(1234);
    // re-read
    const reloaded = await loadConfig(file);
    expect(reloaded.server.port).toBe(1234);
  });

  it("setKey rejects unknown section", async () => {
    const cfg = await loadConfig(file);
    await expect(setKey(cfg, "nope.key", "x", file)).rejects.toThrow(/unknown section/);
  });

  it("setKey rejects unknown key", async () => {
    const cfg = await loadConfig(file);
    await expect(setKey(cfg, "server.nope", "x", file)).rejects.toThrow(/unknown key/);
  });

  it("setKey coerces strings to numbers", async () => {
    const cfg = await loadConfig(file);
    const r = await setKey(cfg, "agents.maxShards", "12", file);
    expect(r.value).toBe(12);
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
  });
});
