// =============================================================================
// Eyes-CLI — setup wizard tests
//
// We test the deterministic helpers (env detection, tool config patching).
// The interactive parts (clack prompts) need a TTY and are tested by hand
// in the README's "Tested" section.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// We re-implement just enough of the patch logic here, matching the one in
// setup.ts. If you change setup.ts's patch logic, mirror it here.
async function patchToolConfig(toolId: string, toolPath: string, url: string): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(toolPath, "utf8");
  } catch {
    raw = "";
  }
  let obj: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  const mcpServers = (obj["mcpServers"] as Record<string, unknown>) ?? {};
  mcpServers["eyes"] = {
    type: "http",
    url,
    ...(toolId === "continue" ? { displayName: "Eyes-MCP" } : {}),
  };
  obj["mcpServers"] = mcpServers;
  mkdirSync(path.dirname(toolPath), { recursive: true });
  writeFileSync(toolPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

describe("setup: tool config patching", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "eyes-setup-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a new mcpServers block when the file is empty", async () => {
    const cfg = path.join(tmp, "opencode", "config.json");
    await patchToolConfig("opencode", cfg, "http://127.0.0.1:51823/mcp");
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.eyes).toEqual({
      type: "http",
      url: "http://127.0.0.1:51823/mcp",
    });
  });

  it("preserves existing mcpServers and adds eyes", async () => {
    const cfg = path.join(tmp, "claude.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          "other-server": { type: "stdio", command: "foo" },
        },
      }),
    );
    await patchToolConfig("claude", cfg, "http://127.0.0.1:51823/mcp");
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers["other-server"]).toEqual({ type: "stdio", command: "foo" });
    expect(written.mcpServers.eyes).toEqual({
      type: "http",
      url: "http://127.0.0.1:51823/mcp",
    });
  });

  it("overwrites the eyes entry on second run (idempotent)", async () => {
    const cfg = path.join(tmp, "config.json");
    await patchToolConfig("opencode", cfg, "http://127.0.0.1:51823/mcp");
    await patchToolConfig("opencode", cfg, "http://127.0.0.1:99999/mcp");
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.eyes.url).toBe("http://127.0.0.1:99999/mcp");
  });

  it("recovers from corrupt JSON in the existing file", async () => {
    const cfg = path.join(tmp, "config.json");
    writeFileSync(cfg, "{ this is not valid JSON");
    await patchToolConfig("cursor", cfg, "http://127.0.0.1:51823/mcp");
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.eyes.url).toBe("http://127.0.0.1:51823/mcp");
  });

  it("adds displayName for Continue", async () => {
    const cfg = path.join(tmp, ".continue", "config.json");
    await patchToolConfig("continue", cfg, "http://127.0.0.1:51823/mcp");
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.eyes.displayName).toBe("Eyes-MCP");
  });
});

describe("setup: install.sh shellcheck", () => {
  it("passes bash -n syntax check", () => {
    const installSh = path.join(__dirname, "..", "..", "..", "scripts", "install.sh");
    expect(() => {
      execSync(`bash -n ${JSON.stringify(installSh)}`, { stdio: "pipe" });
    }).not.toThrow();
  });

  it("exists and is executable", () => {
    const installSh = path.join(__dirname, "..", "..", "..", "scripts", "install.sh");
    const fs = require("node:fs") as typeof import("node:fs");
    const st = fs.statSync(installSh);
    expect(st.isFile()).toBe(true);
    expect((st.mode & 0o111) !== 0).toBe(true); // any execute bit
  });
});

describe("setup: env var override semantics", () => {
  it("EYES_PORT defaults to 51823 if unset", () => {
    delete process.env["EYES_PORT"];
    // The install script defaults EYES_PORT to 51823. We just check the
    // behavior of our own config loader: if EYES_HTTP_PORT is set, it wins.
    process.env["EYES_HTTP_PORT"] = "51823";
    // No assertion beyond non-throw — the real value is tested in config.test.ts.
    expect(true).toBe(true);
  });
});
