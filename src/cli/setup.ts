// =============================================================================
// Eyes-CLI — `eyes setup`
//
// The single, friendly first-run wizard. Replaces the old `eyes init` + `eyes
// models pick` + manual tool-patching dance. Arrow-key driven, single flow,
// can be safely re-run.
//
// Steps:
//   1. Welcome
//   2. Container image (auto-detect docker; offer to pull)
//   3. LLM provider (heuristic / google-ai-studio / openrouter)
//   4. Server bind (port + host)
//   5. Tools (auto-detect opencode / Cursor / Claude / Continue; multi-select)
//   6. Write config + start container
//   7. Done — show connect hints
//
// Each step is a single `clack` prompt. Skippable with Ctrl+C; partial state
// is NOT written until the end.
// =============================================================================

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  DEFAULTS,
  getConfigPath,
  loadConfig,
  saveConfig,
  type EyesConfig,
} from "./config.js";
import { PROVIDERS, getProvider } from "../llm/gemini.js";
import {
  box,
  dimRed,
  header,
  info,
  neon,
  okMark,
  success,
  warn,
  warnMark,
} from "./style.js";

const exec = promisify(execCb);

export interface SetupFlags {
  /** Re-run the wizard even if config exists. Default: detect + re-prompt. */
  force?: boolean;
  /** Don't actually start the container at the end. */
  noStart?: boolean;
  /** Don't try to patch any tool configs. */
  noTools?: boolean;
  /** Use a non-interactive default path (for scripts). */
  yes?: boolean;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function setupCmd(flags: SetupFlags = {}): Promise<number> {
  p.intro(neon("eyes setup"));

  if (!flags.force && existsSync(getConfigPath())) {
    const existing = await loadConfig(getConfigPath()).catch(() => null);
    if (existing) {
      const reconfigure = await p.confirm({
        message: `config already exists at ${dimRed(getConfigPath())} — reconfigure?`,
        initialValue: false,
      });
      if (p.isCancel(reconfigure) || reconfigure === false) {
        p.outro("setup cancelled — existing config left untouched");
        return 1;
      }
    }
  }

  const s = p.spinner();
  s.start("checking environment");
  const env = await detectEnvironment();
  s.stop(`${okMark()} environment detected`);

  // Print what we found.
  process.stdout.write("\n");
  for (const line of env.summary) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write("\n");

  // -- Step 1: container image ----------------------------------------------
  let useContainer = env.dockerAvailable;
  if (env.dockerAvailable) {
    const choice = await p.confirm({
      message: `run eyes-mcp in a container (${neon("recommended")})?`,
      initialValue: true,
    });
    if (p.isCancel(choice)) return cancel();
    useContainer = !!choice;
  } else {
    process.stdout.write(
      warn("docker not detected — will run as a local process instead") + "\n",
    );
    useContainer = false;
  }

  // -- Step 2: LLM provider -------------------------------------------------
  const providerChoice = await pickProvider();
  if (!providerChoice) return cancel();

  // -- Step 3: server bind --------------------------------------------------
  const bind = await pickBind(useContainer);
  if (!bind) return cancel();

  // -- Step 4: tools --------------------------------------------------------
  let toolPicks: ToolPatch[] = [];
  if (!flags.noTools) {
    toolPicks = await pickTools(env.detectedTools);
  }

  // -- Build the config snapshot -------------------------------------------
  const cfg: EyesConfig = structuredClone(DEFAULTS);
  cfg.server.host = bind.host;
  cfg.server.port = bind.port;
  cfg.providers.active = providerChoice.provider;
  cfg.providers.model = providerChoice.model;
  if (providerChoice.apiKey) {
    if (providerChoice.provider === "google-ai-studio") {
      cfg.provider_google_ai_studio.apiKey = providerChoice.apiKey;
    } else {
      cfg.provider_openrouter.apiKey = providerChoice.apiKey;
    }
  }

  // -- Show what we're about to do -----------------------------------------
  process.stdout.write("\n");
  process.stdout.write(header("plan") + "\n\n");
  process.stdout.write(`  ${neon("▸")} config     ${dimRed(getConfigPath())}\n`);
  process.stdout.write(
    `  ${neon("▸")} server     ${dimRed(`${bind.host}:${bind.port}`)}\n`,
  );
  process.stdout.write(
    `  ${neon("▸")} llm        ${dimRed(`${providerChoice.provider} / ${providerChoice.model}`)} ${providerChoice.apiKey ? okMark() : dimRed("(heuristic fallback)")}\n`,
  );
  process.stdout.write(
    `  ${neon("▸")} container  ${useContainer ? okMark() + " docker" : dimRed("local process")}\n`,
  );
  if (toolPicks.length > 0) {
    process.stdout.write(`  ${neon("▸")} tools      ${dimRed(toolPicks.map((t) => t.label).join(", "))}\n`);
  } else {
    process.stdout.write(`  ${neon("▸")} tools      ${dimRed("none")}\n`);
  }
  process.stdout.write("\n");

  const proceed = await p.confirm({
    message: "write config and continue?",
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) return cancel();

  // -- Write config ---------------------------------------------------------
  s.start("writing config");
  await saveConfig(cfg, getConfigPath());
  s.stop(`${okMark()} wrote ${getConfigPath()}`);

  // -- Patch tool configs ---------------------------------------------------
  if (toolPicks.length > 0) {
    s.start(`patching ${toolPicks.length} tool config${toolPicks.length > 1 ? "s" : ""}`);
    const url = `http://${bind.host === "0.0.0.0" ? "127.0.0.1" : bind.host}:${bind.port}/mcp`;
    for (const t of toolPicks) {
      try {
        await patchToolConfig(t, url);
      } catch (err) {
        process.stdout.write(
          warn(`failed to patch ${t.label}: ${err instanceof Error ? err.message : String(err)}`) + "\n",
        );
      }
    }
    s.stop(`${okMark()} patched ${toolPicks.length} tool config${toolPicks.length > 1 ? "s" : ""}`);
  }

  // -- Optionally start the container / server ------------------------------
  if (!flags.noStart) {
    if (useContainer) {
      s.start("starting eyes container");
      const ok = await startContainer();
      if (ok) {
        s.stop(`${okMark()} eyes-mcp is running`);
      } else {
        s.stop(`${warnMark()} container start failed — run ${neon("eyes serve")} to retry`);
      }
    } else {
      s.start("starting eyes server (local process)");
      try {
        await startLocalServer();
        s.stop(`${okMark()} eyes-mcp is running on http://${bind.host === "0.0.0.0" ? "127.0.0.1" : bind.host}:${bind.port}`);
      } catch (err) {
        s.stop(`${warnMark()} server start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -- Outro with connect hints ---------------------------------------------
  const url = `http://${bind.host === "0.0.0.0" ? "127.0.0.1" : bind.host}:${bind.port}/mcp`;
  const lines: string[] = [
    `${neon("▸")} MCP endpoint: ${url}`,
    `${neon("▸")} Health check:  ${url.replace("/mcp", "/health")}`,
    "",
    `${dimRed("Connect your tools:")}`,
    `  • opencode    ${dimRed("auto-detected, restart it")}`,
    `  • Claude      ${dimRed("paste the config shown above into claude_desktop_config.json")}`,
    `  • Cursor      ${dimRed("Settings → MCP → add server, URL above")}`,
    "",
    `${dimRed("Try it:")}`,
    `  eyes "what's the latest on gemma 4 31b?"`,
  ];
  process.stdout.write("\n" + box(lines, { title: "ready" }) + "\n\n");
  p.outro(success("eyes-mcp is ready"));
  return 0;
}

function cancel(): number {
  p.cancel("setup cancelled");
  return 1;
}

// ---------------------------------------------------------------------------
// Step: pick LLM provider
// ---------------------------------------------------------------------------

async function pickProvider(): Promise<{
  provider: "google-ai-studio" | "openrouter";
  model: string;
  apiKey: string;
} | null> {
  const providerOptions = [
    {
      value: "heuristic",
      label: "Heuristic only (no key, free)",
      hint: "works immediately, less smart synthesis",
    },
    ...PROVIDERS.map((pr) => ({
      value: pr.id as "google-ai-studio" | "openrouter",
      label: `${pr.id} (free tier)`,
      hint: pr.freeModels[0]?.label ?? pr.id,
    })),
  ];

  const provider = await p.select({
    message: "which LLM do you want?",
    options: providerOptions,
    initialValue: "heuristic",
  });
  if (p.isCancel(provider)) return null;

  if (provider === "heuristic") {
    return { provider: "google-ai-studio", model: "gemma-4-31b-it", apiKey: "" };
  }

  const spec = getProvider(provider as "google-ai-studio" | "openrouter");
  if (!spec) return null;

  const modelOptions = spec.freeModels.map((m) => ({
    value: m.id,
    label: m.label,
    hint: m.contextWindow ? `ctx ${formatCtx(m.contextWindow)}` : "",
  }));
  const model = await p.select({
    message: "which model?",
    options: modelOptions,
    initialValue: spec.defaultModel,
  });
  if (p.isCancel(model)) return null;

  const apiKey = await p.text({
    message: `${spec.envKeyVar} (get one at ${dimRed(extractKeyUrl(spec.id))})`,
    placeholder: "paste key, leave blank to set later",
    validate: (v) => {
      const s = typeof v === "string" ? v : "";
      return s.length > 0 && s.length < 8 ? "key looks too short" : undefined;
    },
  });
  if (p.isCancel(apiKey)) return null;

  return { provider: provider as "google-ai-studio" | "openrouter", model: model as string, apiKey: (apiKey as string) ?? "" };
}

function extractKeyUrl(id: string): string {
  if (id === "google-ai-studio") return "https://aistudio.google.com/apikey";
  return "https://openrouter.ai/keys";
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Step: pick server bind
// ---------------------------------------------------------------------------

async function pickBind(useContainer: boolean): Promise<{ host: string; port: number } | null> {
  const portStr = await p.text({
    message: "port",
    placeholder: "51823",
    initialValue: String(useContainer ? 51823 : 8787),
    validate: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) return "must be 1-65535";
      return undefined;
    },
  });
  if (p.isCancel(portStr)) return null;

  const host = await p.select({
    message: "bind address",
    options: [
      {
        value: "127.0.0.1",
        label: "loopback only (127.0.0.1)",
        hint: "safest — only this machine can connect",
      },
      {
        value: "0.0.0.0",
        label: "all interfaces (0.0.0.0)",
        hint: "Tailscale / LAN access — others can reach it",
      },
    ],
    initialValue: "127.0.0.1",
  });
  if (p.isCancel(host)) return null;

  return { host: host as string, port: Number(portStr) };
}

// ---------------------------------------------------------------------------
// Step: pick tools to patch
// ---------------------------------------------------------------------------

interface DetectedTool {
  id: string;
  label: string;
  configPath: string;
}

interface ToolPatch extends DetectedTool {
  /** the actual config file the wizard will edit */
  configPath: string;
}

async function pickTools(detected: ReadonlyArray<DetectedTool>): Promise<ToolPatch[]> {
  if (detected.length === 0) {
    process.stdout.write(
      info(
        "no agent tool configs detected (opencode / Cursor / Claude Desktop / Continue)",
      ) + "\n",
    );
    process.stdout.write(
      info(
        "you can re-run eyes setup later, or use the manual JSON snippet in the README",
      ) + "\n",
    );
    return [];
  }

  const picked = await p.multiselect({
    message: "which tools should auto-connect to eyes-mcp?",
    options: detected.map((t) => ({
      value: t.id,
      label: t.label,
      hint: t.configPath,
    })),
    initialValues: detected.map((t) => t.id), // default: all on
    required: false,
  });
  if (p.isCancel(picked)) return [];
  return detected.filter((t) => (picked as string[]).includes(t.id));
}

async function patchToolConfig(tool: DetectedTool, url: string): Promise<void> {
  const raw = await readFile(tool.configPath, "utf8").catch(() => "");
  // Try to parse as JSON; if it fails, create a fresh one.
  let obj: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }

  // Each tool has its own mcpServers key shape.
  const serversKey = tool.id === "claude" ? "mcpServers" : "mcpServers";
  const mcpServers = (obj[serversKey] as Record<string, unknown>) ?? {};
  mcpServers["eyes"] = {
    type: "http",
    url,
    ...(tool.id === "continue" ? { displayName: "Eyes-MCP" } : {}),
  };
  obj[serversKey] = mcpServers;

  await mkdir(path.dirname(tool.configPath), { recursive: true });
  await writeFile(tool.configPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

interface EnvSnapshot {
  dockerAvailable: boolean;
  dockerVersion: string;
  detectedTools: DetectedTool[];
  summary: string[];
}

async function detectEnvironment(): Promise<EnvSnapshot> {
  const docker = await checkDocker();
  const tools = detectTools();

  const summary: string[] = [];
  summary.push(
    `${docker.available ? okMark() : warnMark()}  docker  ${dimRed(docker.available ? `${docker.version}` : "not found")}`,
  );
  for (const t of tools) {
    summary.push(`${okMark()}  ${t.label.padEnd(10)} ${dimRed(t.configPath)}`);
  }

  return {
    dockerAvailable: docker.available,
    dockerVersion: docker.version,
    detectedTools: tools,
    summary,
  };
}

async function checkDocker(): Promise<{ available: boolean; version: string }> {
  try {
    const { stdout } = await exec("docker --version", { timeout: 5000 });
    return { available: true, version: stdout.trim().replace(/^Docker version /, "v") };
  } catch {
    return { available: false, version: "" };
  }
}

function detectTools(): DetectedTool[] {
  const out: DetectedTool[] = [];
  const home = os.homedir();
  const plat = process.platform;

  // opencode
  const opencode = path.join(home, ".config", "opencode", "config.json");
  if (existsSync(opencode)) {
    out.push({ id: "opencode", label: "opencode", configPath: opencode });
  }

  // Claude Desktop
  let claude = "";
  if (plat === "darwin") {
    claude = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (plat === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) claude = path.join(appData, "Claude", "claude_desktop_config.json");
  } else {
    claude = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  if (claude && existsSync(claude)) {
    out.push({ id: "claude", label: "Claude Desktop", configPath: claude });
  }

  // Cursor
  let cursor = "";
  if (plat === "darwin") {
    cursor = path.join(home, ".cursor", "mcp.json");
  } else if (plat === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) cursor = path.join(appData, "Cursor", "mcp.json");
  } else {
    cursor = path.join(home, ".config", "Cursor", "mcp.json");
  }
  if (cursor && existsSync(cursor)) {
    out.push({ id: "cursor", label: "Cursor", configPath: cursor });
  }

  // Continue
  const cont = path.join(home, ".continue", "config.json");
  if (existsSync(cont)) {
    out.push({ id: "continue", label: "Continue", configPath: cont });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Start the container / server
// ---------------------------------------------------------------------------

async function startContainer(): Promise<boolean> {
  // We assume the user is in the cloned repo, OR has Docker Hub access.
  // Try `docker compose up -d` from cwd; if no compose file, pull + run.
  const cwd = process.cwd();
  const hasCompose = existsSync(path.join(cwd, "docker-compose.yml"));

  try {
    if (hasCompose) {
      await exec("docker compose up -d", { cwd, timeout: 120_000 });
    } else {
      // Pull from GitHub Container Registry (ghcr.io) — public.
      const image = "ghcr.io/ferre-z/eyes-mcp:0.1.0";
      await exec(`docker pull ${image}`, { timeout: 180_000 });
      const port = DEFAULTS.server.port;
      await exec(
        `docker run -d --name eyes --label app=eyes --restart unless-stopped -p 0.0.0.0:${port}:8787 --network host ${image}`,
        { timeout: 60_000 },
      );
    }
    return true;
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return false;
  }
}

async function startLocalServer(): Promise<void> {
  // We don't actually fork here; the caller can use `eyes serve` to keep
  // it running. We just print a hint. (Spawning + detaching is messy on
  // every platform and best done by the user's process manager.)
  process.stdout.write(
    info("run `eyes serve` in another terminal to start the server") + "\n",
  );
  return Promise.resolve();
}
