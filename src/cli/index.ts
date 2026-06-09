// =============================================================================
// Eyes-CLI — entry point
//
// Parsed by meow. Dispatches:
//   eyes              → REPL (chatRepl)
//   eyes chat <p>     → one-shot research (chatOneShot)
//   eyes serve        → start the MCP HTTP server
//   eyes config ...   → config editor / get / set / path
//   eyes init         → create the config file
//   eyes doctor       → run diagnostics
//
// Flags:
//   --reveal    print secret config values
//   --json      output JSON (where applicable)
//   --no-color  disable neon red
//   --depth     quick | standard | deep (default from config)
//   --max-shards N
//   --model     override the LLM model name for this run
// =============================================================================

import meow from "meow";
import pc from "picocolors";
import { box, dimRed, neon } from "./style.js";
import { chatOneShot, chatRepl } from "./chat.js";
import { startServer } from "./server.js";
import { configCmd } from "./config-cmd.js";
import { initCmd } from "./init.js";
import { doctor } from "./doctor.js";
import { modelsCmd } from "./models.js";

export const cli = meow(
  `
${neon("Usage")}
  $ eyes                        ${dimRed("open the chat REPL")}
  $ eyes chat <prompt>          ${dimRed("one-shot research question")}
  $ eyes models list            ${dimRed("show all free models across providers")}
  $ eyes models pick            ${dimRed("interactive wizard: provider + model + key")}
  $ eyes models current         ${dimRed("print the active provider + model")}
  $ eyes serve                  ${dimRed("start the MCP HTTP server")}
  $ eyes config                 ${dimRed("interactive config editor")}
  $ eyes config get <key>       ${dimRed("print a config value")}
  $ eyes config set <k> <v>     ${dimRed("set a config value")}
  $ eyes config path            ${dimRed("print the config file path")}
  $ eyes init                   ${dimRed("create the config file with defaults")}
  $ eyes doctor                 ${dimRed("check config + dependencies + llm")}

${neon("Options")}
  --depth <lvl>     ${dimRed("quick | standard | deep (default from config)")}
  --max-shards <n>  ${dimRed("override EYES_MAX_SHARDS for this run")}
  --model <name>    ${dimRed("override the LLM model name for this run")}
  --reveal          ${dimRed("print secret config values (api keys, tokens)")}
  --json            ${dimRed("output in JSON instead of pretty")}
  --no-color        ${dimRed("disable neon red output")}

${neon("Examples")}
  $ eyes models pick                       ${dimRed("# first-time setup")}
  $ eyes ${dimRed(`"what's the latest on gemma 4 31b?"`)}
  $ eyes chat ${dimRed(`"compare bun and deno for scripting"`)} --depth deep
  $ eyes config set providers.model llama-3.3-70b
  $ eyes doctor
`,
  {
    importMeta: import.meta,
    autoHelp: true,
    autoVersion: true,
    flags: {
      reveal: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      color: { type: "boolean", default: true },
      depth: { type: "string" },
      maxShards: { type: "number" },
      model: { type: "string" },
    },
  },
);

void pc;

const cmd = cli.input[0];
const rest = cli.input.slice(1);

let exitCode = 0;
try {
  switch (cmd) {
    case "serve":
      await startServer();
      break;
    case "config":
      exitCode = await configCmd(rest, {
        reveal: cli.flags.reveal,
        json: cli.flags.json,
      });
      break;
    case "models":
      exitCode = await modelsCmd(rest, { reveal: cli.flags.reveal, json: cli.flags.json });
      break;
    case "init":
      exitCode = await initCmd({ force: false, reveal: cli.flags.reveal, json: cli.flags.json });
      break;
    case "doctor":
      exitCode = await doctor({ reveal: cli.flags.reveal, json: cli.flags.json });
      break;
    case "chat":
      exitCode = await chatOneShot(rest.join(" "), {
        depth: cli.flags.depth as "quick" | "standard" | "deep" | undefined,
        maxShards: cli.flags.maxShards,
        json: cli.flags.json,
        reveal: cli.flags.reveal,
        model: cli.flags.model,
      });
      break;
    case "help":
    case "--help":
    case "-h":
      // meow already printed help
      break;
    case "version":
    case "--version":
    case "-v":
      // meow already printed version
      break;
    case undefined:
      exitCode = await chatRepl({
        depth: cli.flags.depth as "quick" | "standard" | "deep" | undefined,
        maxShards: cli.flags.maxShards,
        json: cli.flags.json,
        reveal: cli.flags.reveal,
        model: cli.flags.model,
      });
      break;
    default: {
      // Unknown first arg → treat as a prompt (matches the "no command, just
      // a research question" ergonomic from clack/hermes-style tools).
      const prompt = [cmd, ...rest].join(" ");
      exitCode = await chatOneShot(prompt, {
        depth: cli.flags.depth as "quick" | "standard" | "deep" | undefined,
        maxShards: cli.flags.maxShards,
        json: cli.flags.json,
        reveal: cli.flags.reveal,
        model: cli.flags.model,
      });
    }
  }
} catch (err) {
  process.stdout.write(
    box([`${dimRed("✗")} ${err instanceof Error ? err.message : String(err)}`], { title: "error" }) +
      "\n",
  );
  exitCode = 1;
}

process.exit(exitCode);
