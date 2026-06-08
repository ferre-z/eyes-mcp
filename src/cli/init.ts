// =============================================================================
// Eyes-CLI — `eyes init`
//
// Creates the config file at the default path with all defaults. If the
// file already exists, asks first via @clack/prompts. After writing,
// prints a success line and offers to open the file in $EDITOR (only if
// running interactively).
// =============================================================================

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { DEFAULTS, getConfigPath, saveConfig, loadConfig } from "./config.js";
import { dimRed, neon, okMark, prompt as promptMark } from "./style.js";

export interface InitFlags {
  force?: boolean;
  reveal?: boolean;
  json?: boolean;
}

export async function initCmd(flags: InitFlags = {}): Promise<number> {
  const path = getConfigPath();
  const exists = existsSync(path);

  if (exists && !flags.force) {
    // Ask before overwriting.
    p.intro(neon("eyes init"));
    const overwrite = await p.confirm({
      message: `${promptMark(" ")} config already exists at ${path} — overwrite with defaults?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || overwrite === false) {
      p.cancel("init cancelled — existing config left untouched");
      return 1;
    }
  }

  await saveConfig(DEFAULTS, path);
  process.stdout.write(`${okMark()} ${dimRed("created")} ${path}\n`);

  // Reload so env overrides are visible (informational only).
  const cfg = await loadConfig(path);
  process.stdout.write(`${dimRed("hint:")} set your ${neon("llm.apiKey")} via ${neon("eyes config set llm.apiKey <key>")}\n`);

  // Offer to open in $EDITOR if TTY and the env var is set.
  if (process.stdout.isTTY && process.env["EDITOR"] && !flags.force) {
    const open = await p.confirm({
      message: `${promptMark(" ")} open in $EDITOR (${process.env["EDITOR"]})?`,
      initialValue: false,
    });
    if (!p.isCancel(open) && open) {
      const editor = process.env["EDITOR"]!;
      const child = spawn(editor, [path], { stdio: "inherit" });
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      });
    }
  }

  void cfg; // currently informational; kept for future expansion
  return 0;
}
