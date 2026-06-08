// =============================================================================
// Eyes-CLI — `eyes config` (interactive editor + get/set/path)
//
// Subcommands:
//   eyes config            open the interactive editor (@clack/prompts)
//   eyes config get <key>  print a single value (secrets show as *** unless --reveal)
//   eyes config set <k> <v>  set a value (coerces to the right type)
//   eyes config path       print the resolved config file path
// =============================================================================

import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import {
  DEFAULTS,
  SECRET_KEYS,
  getConfigPath,
  loadConfig,
  saveConfig,
  setKey,
  type EyesConfig,
} from "./config.js";
import { dimRed, error, header, info, neon, okMark, warn } from "./style.js";

export interface ConfigFlags {
  reveal?: boolean;
  json?: boolean;
  force?: boolean;
}

export async function configCmd(args: string[], flags: ConfigFlags = {}): Promise<number> {
  const sub = args[0];

  switch (sub) {
    case undefined:
    case "edit":
      return interactive(flags);
    case "get":
      return getValue(args[1], flags);
    case "set":
      return setValue(args[1], args[2], flags);
    case "path":
      process.stdout.write(getConfigPath() + "\n");
      return 0;
    default:
      process.stdout.write(error(`unknown subcommand "${sub}"`) + "\n");
      process.stdout.write(info("try: eyes config | get | set | path") + "\n");
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Interactive editor
// ---------------------------------------------------------------------------

async function interactive(flags: ConfigFlags): Promise<number> {
  void flags;
  const filePath = getConfigPath();
  const cfg = existsSync(filePath) ? await loadConfig(filePath) : DEFAULTS;

  p.intro(neon("eyes config"));

  // Walk through top-level sections. For each, ask the user to confirm or
  // update the values. We use a single select per section to keep this
  // tight — v1 isn't trying to be a full form editor.
  const updated = { ...cfg };

  for (const section of Object.keys(DEFAULTS) as Array<keyof EyesConfig>) {
    const obj = DEFAULTS[section] as Record<string, unknown>;
    const cur = updated[section] as Record<string, unknown>;

    const action = await p.select({
      message: `${dimRed("▸")} section ${neon(section)} — keep, edit, or skip?`,
      options: [
        { value: "keep", label: "keep current" },
        { value: "edit", label: "edit" },
        { value: "skip", label: "skip" },
      ],
      initialValue: "keep",
    });
    if (p.isCancel(action) || action === "skip") continue;
    if (action === "keep") continue;

    for (const k of Object.keys(obj)) {
      const isSecret = SECRET_KEYS.has(`${section}.${k}`);
      const display = isSecret
        ? (cur[k] && String(cur[k]).length > 0 ? "***" : "(empty)")
        : String(cur[k]);
      const next = await p.text({
        message: `${neon(`${section}.${k}`)} ${dimRed("current:")} ${display}`,
        placeholder: isSecret ? "paste new value (enter to keep)" : String(obj[k]),
        defaultValue: undefined,
      });
      if (p.isCancel(next)) {
        p.cancel("edit cancelled");
        return 1;
      }
      if (next && String(next).length > 0) {
        try {
          cur[k] = coerce(next, obj[k]);
        } catch (err) {
          process.stdout.write(warn(`${section}.${k}: ${(err as Error).message}`) + "\n");
        }
      }
    }
  }

  const confirm = await p.confirm({
    message: "save these changes?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || confirm === false) {
    p.cancel("nothing saved");
    return 1;
  }

  await saveConfig(updated, filePath);
  p.outro(`${okMark()} saved to ${filePath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------

async function getValue(key: string | undefined, flags: ConfigFlags): Promise<number> {
  if (!key) {
    process.stdout.write(error("missing key — try: eyes config get llm.model") + "\n");
    return 2;
  }
  const cfg = await loadConfig();
  const v = resolvePath(cfg, key);
  if (v === undefined) {
    process.stdout.write(error(`unknown key "${key}"`) + "\n");
    return 1;
  }
  if (SECRET_KEYS.has(key) && !flags.reveal) {
    const str = String(v);
    process.stdout.write(str.length > 0 ? "***\n" : "(empty)\n");
    return 0;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ [key]: v }, null, 2) + "\n");
  } else {
    process.stdout.write(`${header(key)}\n${String(v)}\n`);
  }
  return 0;
}

async function setValue(
  key: string | undefined,
  value: string | undefined,
  _flags: ConfigFlags,
): Promise<number> {
  if (!key || value === undefined) {
    process.stdout.write(
      error("usage: eyes config set <section.key> <value>") + "\n",
    );
    return 2;
  }
  const cfg = await loadConfig();
  try {
    const { section, key: k, value: coerced } = await setKey(cfg, key, value);
    process.stdout.write(
      `${okMark()} ${neon(`${section}.${k}`)} = ${String(coerced)}\n`,
    );
    return 0;
  } catch (err) {
    process.stdout.write(error((err as Error).message) + "\n");
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(obj: EyesConfig, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

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
