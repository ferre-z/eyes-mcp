// =============================================================================
// Eyes-CLI — `eyes models`
//
// Subcommands:
//   eyes models list           table of all providers and their free models
//   eyes models pick           interactive wizard: provider → model → key
//   eyes models current        print the currently configured provider+model
//
// Designed to be the "do everything in one go" entry point — like
// `hermes model`.
// =============================================================================

import * as p from "@clack/prompts";
import { PROVIDERS, getProvider, type ProviderSpec } from "../llm/gemini.js";
import { DEFAULTS, loadConfig, saveConfig, getConfigPath, type EyesConfig } from "./config.js";
import { box, dimRed, error as errStyle, header, info, neon, okMark, warn } from "./style.js";

export interface ModelsFlags {
  reveal?: boolean;
  json?: boolean;
}

/** Map provider id -> the apiKey field name on EyesConfig. */
function apiKeyField(providerId: ProviderSpec["id"]): keyof EyesConfig {
  return providerId === "google-ai-studio" ? "provider_google_ai_studio" : "provider_openrouter";
}

export async function modelsCmd(args: string[], flags: ModelsFlags = {}): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listModels(flags);
    case "pick":
    case "select":
    case "set":
      return pickInteractive(flags);
    case "current":
    case "status":
      return currentProvider(flags);
    default:
      process.stdout.write(errStyle(`unknown subcommand "${sub}"`) + "\n");
      process.stdout.write(info("try: eyes models list | pick | current") + "\n");
      return 2;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listModels(_flags: ModelsFlags): Promise<number> {
  const lines: string[] = [];
  lines.push(neon("Free models catalog"));
  lines.push("");

  for (const provider of PROVIDERS) {
    lines.push(`${neon(provider.id)}  ${dimRed(`(${provider.envKeyVar})`)}`);
    lines.push(`  ${dimRed("endpoint:")} ${provider.baseUrl}`);
    lines.push("");
    for (const m of provider.freeModels) {
      const ctx = m.contextWindow ? dimRed(`ctx ${formatCtx(m.contextWindow)}`) : "";
      lines.push(`  ${neon("▸")} ${m.id}  ${dimRed("—")} ${m.label}  ${ctx}`);
    }
    lines.push("");
  }

  process.stdout.write(box(lines, { title: "models" }) + "\n");
  process.stdout.write(info("run `eyes models pick` to choose one") + "\n");
  return 0;
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// current
// ---------------------------------------------------------------------------

async function currentProvider(_flags: ModelsFlags): Promise<number> {
  const cfg = await loadConfig();
  const provider = getProvider(cfg.providers.active);
  const keyField = apiKeyField(cfg.providers.active);
  const apiKey = (cfg[keyField] as { apiKey: string }).apiKey;
  const lines: string[] = [
    `${neon("active provider:")} ${cfg.providers.active}`,
    `${neon("model:")}         ${cfg.providers.model}`,
    `${neon("api key:")}       ${apiKey.length > 0 ? "set" : "(empty)"}`,
  ];
  if (provider) {
    lines.push(`${neon("endpoint:")}      ${provider.baseUrl}`);
  }
  process.stdout.write(box(lines, { title: "current" }) + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// pick (the wizard)
// ---------------------------------------------------------------------------

async function pickInteractive(_flags: ModelsFlags): Promise<number> {
  void _flags;
  const filePath = getConfigPath();
  const cfg = (await loadConfig(filePath).catch(() => structuredClone(DEFAULTS))) as EyesConfig;

  p.intro(neon("eyes models — pick a free LLM"));

  // 1. Provider
  const providerChoice = await p.select({
    message: `${neon("▸")} which provider?`,
    options: PROVIDERS.map((prov) => ({
      value: prov.id,
      label: `${prov.id}  ${dimRed(`(${prov.freeModels.length} free models)`)}`,
    })),
    initialValue: cfg.providers.active,
  });
  if (p.isCancel(providerChoice)) {
    p.cancel("no changes saved");
    return 1;
  }
  const provider = getProvider(String(providerChoice));
  if (!provider) {
    p.cancel(`unknown provider: ${String(providerChoice)}`);
    return 1;
  }

  // 2. Model
  const modelChoice = await p.select({
    message: `${neon("▸")} which model on ${provider.id}?`,
    options: provider.freeModels.map((m) => ({
      value: m.id,
      label: `${m.id}  ${dimRed("—")} ${m.label}`,
    })),
    initialValue:
      cfg.providers.model && provider.freeModels.some((m) => m.id === cfg.providers.model)
        ? cfg.providers.model
        : provider.defaultModel,
  });
  if (p.isCancel(modelChoice)) {
    p.cancel("no changes saved");
    return 1;
  }

  // 3. API key (paste). We treat the secret specially: show *** if already set.
  const keyField = apiKeyField(provider.id);
  const current = (cfg[keyField] as { apiKey: string }).apiKey;
  const keyPrompt = await p.text({
    message: `${neon("▸")} ${provider.envKeyVar} ${dimRed(
      current ? "(already set — enter to keep, paste to replace):" : "(paste your API key):",
    )}`,
    placeholder: current ? "***" : "paste key",
  });
  if (p.isCancel(keyPrompt)) {
    p.cancel("no changes saved");
    return 1;
  }
  const finalKey =
    keyPrompt && keyPrompt.length > 0 ? String(keyPrompt) : current;

  // 4. Confirm + write
  const confirm = await p.confirm({
    message: `save: ${neon(provider.id)} / ${neon(String(modelChoice))}?`,
    initialValue: true,
  });
  if (p.isCancel(confirm) || confirm === false) {
    p.cancel("nothing saved");
    return 1;
  }

  cfg.providers.active = provider.id;
  cfg.providers.model = String(modelChoice);
  (cfg[keyField] as { apiKey: string }).apiKey = finalKey;
  await saveConfig(cfg, filePath);

  p.outro(`${okMark()} saved to ${filePath}`);
  return 0;
}

void warn; // kept exported from style for future use
void header;
