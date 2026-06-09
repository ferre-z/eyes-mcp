// =============================================================================
// Eyes-CLI — `eyes chat` and the default TUI REPL
//
// Two modes:
//   * One-shot: `eyes chat "prompt here"` runs MainAgent.research() once
//     and prints the answer inside a neon-bordered box.
//   * REPL: bare `eyes` (or `eyes` with no recognized subcommand) opens
//     a readline loop. Slash-commands: /help /clear /config /doctor /exit.
//     Anything else is a research prompt.
//
// The REPL keeps the last 3 answers in scrollable history; each new turn
// shows the new answer and the previous ones stay visible above the prompt.
// =============================================================================

import { createInterface, type Interface as RLInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { MainAgent } from "../main-agent/index.js";
import { OpenAICompatibleClient, getProvider } from "../llm/gemini.js";
import type { LLMClient } from "../llm/client.js";
import { loadConfig } from "./config.js";
import type { Logger } from "winston";
import {
  bullet,
  box,
  dimRed,
  error as errStyle,
  header,
  info,
  neon,
  okMark,
  prompt as promptMark,
  warn,
} from "./style.js";

export interface ChatFlags {
  depth?: "quick" | "standard" | "deep";
  maxShards?: number;
  json?: boolean;
  reveal?: boolean;
  model?: string;
}

interface AnswerEntry {
  prompt: string;
  answer: string;
  mode: "llm" | "heuristic";
  durationMs: number;
  iterations: number;
  shards: number;
}

const HISTORY_MAX = 3;

// ---------------------------------------------------------------------------
// One-shot
// ---------------------------------------------------------------------------

export async function chatOneShot(prompt: string, flags: ChatFlags): Promise<number> {
  if (!prompt || prompt.trim().length === 0) {
    process.stdout.write(errStyle("usage: eyes chat <prompt>") + "\n");
    return 2;
  }
  try {
    const { answer, history } = await runTurn(prompt, flags);
    process.stdout.write("\n" + renderAnswer(answer) + "\n");
    if (flags.json) {
      process.stdout.write("\n" + JSON.stringify(history, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    process.stdout.write(errStyle((err as Error).message) + "\n");
    return 1;
  }
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export async function chatRepl(flags: ChatFlags): Promise<number> {
  printBanner();
  const history: AnswerEntry[] = [];
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // SIGINT handler — graceful exit, keep history visible.
  process.on("SIGINT", () => {
    void close(rl, history, flags);
  });

  process.stdout.write(info("type /help for commands, /exit to quit") + "\n\n");

  for (;;) {
    let line: string;
    try {
      line = await rl.question(promptMark(" "));
    } catch {
      // EOF (Ctrl+D)
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "/help" || trimmed === "?") {
      printHelp();
      continue;
    }
    if (trimmed === "/clear" || trimmed === "cls") {
      process.stdout.write("\x1b[2J\x1b[H");
      printBanner();
      continue;
    }
    if (trimmed === "/config") {
      const cfg = await loadConfig();
      process.stdout.write("\n" + box(renderConfigLines(cfg), { title: "config" }) + "\n\n");
      continue;
    }
    if (trimmed === "/doctor") {
      const { doctor } = await import("./doctor.js");
      const code = await doctor({});
      void code;
      continue;
    }
    if (trimmed === "/history") {
      for (const h of history) {
        process.stdout.write(bullet(`${h.prompt}  ${dimRed("→")} ${h.answer.slice(0, 80)}…`) + "\n");
      }
      if (history.length === 0) process.stdout.write(dimRed("  (no history yet)") + "\n");
      continue;
    }

    process.stdout.write(dimRed("  …thinking\n"));
    try {
      const { answer } = await runTurn(trimmed, flags);
      history.push(answer);
      while (history.length > HISTORY_MAX) history.shift();
      process.stdout.write("\n" + renderAnswer(answer) + "\n");
    } catch (err) {
      process.stdout.write(errStyle((err as Error).message) + "\n");
    }
  }

  return await close(rl, history, flags);
}

async function close(rl: RLInterface, history: AnswerEntry[], flags: ChatFlags): Promise<number> {
  rl.close();
  if (history.length > 0 && flags.json) {
    process.stdout.write("\n" + JSON.stringify(history, null, 2) + "\n");
  }
  process.stdout.write("\n" + dimRed("bye.") + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Core — run a single research turn
// ---------------------------------------------------------------------------

async function runTurn(
  prompt: string,
  flags: ChatFlags,
): Promise<{ answer: AnswerEntry; history: AnswerEntry[] }> {
  const cfg = await loadConfig();
  // If the config didn't set a data dir (or it's not writable), use a
  // per-user temp dir so the CLI "just works" without docker.
  let dataDir = process.env["EYES_DATA_DIR"] ?? "";
  if (dataDir.length === 0) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    dataDir = await mkdtemp(path.join(tmpdir(), "eyes-"));
  }
  const llm = makeLlmClient(cfg, flags.model);
  const agent = new MainAgent({
    llm,
    adapters: await loadAdapters(),
    logger: consoleLogger(),
    dataDir,
    tokenBudget: cfg.agents.tokenBudget,
    timeBudgetSec: cfg.agents.timeBudgetSec,
  });

  const input: Record<string, unknown> = {
    prompt,
    depth: flags.depth ?? cfg.agents.defaultDepth,
    maxShards: flags.maxShards ?? cfg.agents.maxShards,
    maxIterations: cfg.agents.maxIterations,
    outputFormat: flags.json ? "json" : "markdown",
  };
  if (cfg.searxng.url) input["scope"] = ["general"];

  const t0 = Date.now();
  const out = await agent.research(input);
  return {
    answer: {
      prompt,
      answer: String(out["answer"] ?? ""),
      mode: (out["mode"] as "llm" | "heuristic") ?? "heuristic",
      durationMs: out["durationMs"] ?? Date.now() - t0,
      iterations: out["iterations"] ?? 1,
      shards: Array.isArray(out["shards"]) ? out["shards"].length : 0,
    },
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderAnswer(e: AnswerEntry): string {
  const lines: string[] = [];
  lines.push(neon(e.answer));
  lines.push("");
  lines.push(
    dimRed(
      `${e.mode === "llm" ? "llm" : "heuristic"} · ${e.iterations} iter · ${e.shards} shards · ${e.durationMs}ms`,
    ),
  );
  return box(lines, { title: `▸ ${e.prompt.slice(0, 40)}${e.prompt.length > 40 ? "…" : ""}` });
}

function renderConfigLines(cfg: Awaited<ReturnType<typeof loadConfig>>): string[] {
  const lines: string[] = [];
  for (const section of Object.keys(cfg) as Array<keyof typeof cfg>) {
    lines.push(neon(`[${section}]`));
    const obj = cfg[section] as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      lines.push(`  ${dimRed(k + ":")} ${String(obj[k])}`);
    }
    lines.push("");
  }
  return lines;
}

function printBanner(): void {
  const lines = [
    `${neon("▸ eyes")} ${dimRed("— research mcp for ai agents")}`,
    `${dimRed("  type a research question, or /help for commands")}`,
  ];
  process.stdout.write(box(lines, { title: "eyes" }) + "\n");
}

function printHelp(): void {
  const lines = [
    `${neon("/help")}      ${dimRed("show this help")}`,
    `${neon("/clear")}     ${dimRed("clear the screen")}`,
    `${neon("/config")}    ${dimRed("show the current config")}`,
    `${neon("/doctor")}    ${dimRed("run diagnostics")}`,
    `${neon("/history")}   ${dimRed("show the last few prompts and answers")}`,
    `${neon("/exit")}      ${dimRed("leave the REPL")}`,
    "",
    `${dimRed("anything else is sent to the main agent as a research prompt.")}`,
  ];
  process.stdout.write(box(lines, { title: "commands" }) + "\n");
}

// ---------------------------------------------------------------------------
// Adapter wiring — lazy import to keep cold start fast
// ---------------------------------------------------------------------------

async function loadAdapters(): Promise<Record<string, unknown>> {
  const [
    { searxngAdapter },
    { crawl4aiAdapter },
    { githubAdapter },
    { redditAdapter },
    { youtubeAdapter },
    { hackernewsAdapter },
    { arxivAdapter },
    { wikipediaAdapter },
  ] = await Promise.all([
    import("../adapters/searxng.js"),
    import("../adapters/crawl4ai.js"),
    import("../adapters/github.js"),
    import("../adapters/reddit.js"),
    import("../adapters/youtube.js"),
    import("../adapters/hackernews.js"),
    import("../adapters/arxiv.js"),
    import("../adapters/wikipedia.js"),
  ]);
  void crawl4aiAdapter;
  return {
    web: searxngAdapter,
    github: githubAdapter,
    reddit: redditAdapter,
    youtube: youtubeAdapter,
    hackernews: hackernewsAdapter,
    arxiv: arxivAdapter,
    wikipedia: wikipediaAdapter,
  } as Record<string, unknown>;
}

function makeLlmClient(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  modelOverride: string | undefined,
): LLMClient | null {
  const provider = getProvider(cfg.providers.active);
  if (!provider) return null;
  const apiKey =
    provider.id === "google-ai-studio"
      ? cfg.provider_google_ai_studio.apiKey
      : cfg.provider_openrouter.apiKey;
  if (!apiKey || apiKey.length === 0) return null;
  return new OpenAICompatibleClient({
    provider,
    apiKey,
    model: modelOverride ?? cfg.providers.model,
  });
}

function consoleLogger(): Pick<Logger, "info" | "warn" | "error" | "debug"> {
  const out = {
    info: (msg: string, meta?: unknown): void => {
      process.stdout.write(info(`${msg} ${meta ? JSON.stringify(meta) : ""}`) + "\n");
    },
    warn: (msg: string, meta?: unknown): void => {
      process.stdout.write(warn(`${msg} ${meta ? JSON.stringify(meta) : ""}`) + "\n");
    },
    error: (msg: string, meta?: unknown): void => {
      process.stdout.write(errStyle(`${msg} ${meta ? JSON.stringify(meta) : ""}`) + "\n");
    },
    debug: (_msg: string, _meta?: unknown): void => {
      // no-op
    },
  };
  return out as unknown as Pick<Logger, "info" | "warn" | "error" | "debug">;
}

void header;
void okMark;
