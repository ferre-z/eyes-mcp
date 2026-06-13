#!/usr/bin/env bash
# =============================================================================
# Eyes-MCP — one-line installer (macOS / Linux)
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/ferre-z/eyes-mcp/main/scripts/install.sh | bash
#
# What it does:
#   1. Detects the platform (darwin / linux, amd64 / arm64)
#   2. Installs Docker if it's not there (via the official convenience scripts)
#   3. Pulls the eyes-mcp image (ghcr.io/ferre-z/eyes-mcp:0.1.0)
#   4. Starts the container in the background
#   5. Installs the `eyes` CLI binary to ~/.local/bin (and warns if not in PATH)
#   6. Prints a one-screen "you're done" summary
#
# Safe to re-run.
# =============================================================================

set -euo pipefail

# ---- pretty output (no TTY deps) --------------------------------------------
RED=$'\033[38;2;255;59;92m'
DIM=$'\033[2m'
GRN=$'\033[32m'
YEL=$'\033[33m'
RST=$'\033[0m'

step()  { printf "%b▸%b %s\n"  "$RED" "$RST" "$1"; }
ok()    { printf "%b✓%b %s\n"  "$GRN" "$RST" "$1"; }
warn()  { printf "%b!%b %s\n"  "$YEL" "$RST" "$1"; }
die()   { printf "%b✗%b %s\n"  "$RED" "$RST" "$1" >&2; exit 1; }

# ---- banner -----------------------------------------------------------------
cat <<'BANNER'

   ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄       ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄
  ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌     ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌
   ▀▀▀▀▀█░█▀▀▀ ▀▀▀▀█░█▀▀▀▀  ▐░█▀▀▀▀█░█▀▀      ▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀█░█▀▀ ▐░█▀▀▀▀▀▀▀█░▌
       ▐░▌        ▐░▌       ▐░▌    ▐░▌         ▐░▌       ▐░▌▐░▌     ▐░▌  ▐░▌       ▐░▌
       ▐░▌        ▐░▌       ▐░▌    ▐░▌         ▐░█▄▄▄▄▄▄▄█░▌▐░█▄▄▄▄▄█░█▄▄ ▐░▌       ▐░▌
       ▐░▌        ▐░▌       ▐░▌    ▐░▌         ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░▌       ▐░▌
       ▐░▌        ▐░▌       ▐░▌    ▐░▌         ▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀█░█▀▀ ▐░▌       ▐░▌
       ▐░▌        ▐░▌       ▐░▌    ▐░▌         ▐░▌       ▐░▌▐░▌     ▐░▌  ▐░▌       ▐░▌
       ▐░▌        ▐░▌    ▄  ▐░▌    ▐░▌         ▐░▌       ▐░▌▐░▌     ▐░▌  ▐░▌       ▐░▌
   ▄▄▄▄▄█░▌    ▄▄▄▄▄█░▌▄▄▄▄▄█░▌   ▐░▌         ▐░▌       ▐░▌▐░▌     ▐░▌  ▐░█▄▄▄▄▄▄▄█░▌
  ▐░░░░░░░▌   ▐░░░░░░░░░░░▌▐░▌    ▐░▌         ▐░▌       ▐░▌▐░▌     ▐░▌  ▐░░░░░░░░░░░▌
   ▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀▀  ▀      ▀           ▀         ▀  ▀       ▀    ▀▀▀▀▀▀▀▀▀▀▀

   research MCP for AI agents · zero-friction install
BANNER

# ---- platform detection -----------------------------------------------------
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  linux|darwin) ;;
  *) die "unsupported OS: $OS — open an issue: https://github.com/ferre-z/eyes-mcp/issues" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac
step "detected: $OS / $ARCH"

# ---- docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  warn "docker not found — installing…"
  if [ "$OS" = "darwin" ]; then
    die "please install Docker Desktop from https://docker.com/products/docker-desktop and re-run"
  fi
  # Linux: use the official convenience installer.
  curl -fsSL https://get.docker.com | sh
  ok "docker installed (you may need to log out and back in for the docker group)"
fi

if ! docker info >/dev/null 2>&1; then
  die "docker is installed but not responding. try: sudo systemctl start docker"
fi
ok "docker is responding"

# ---- pull image -------------------------------------------------------------
IMAGE="${EYES_IMAGE:-ghcr.io/ferre-z/eyes-mcp:0.1.0}"
step "pulling $IMAGE"
docker pull --quiet "$IMAGE" >/dev/null
ok "image pulled"

# ---- port handling ----------------------------------------------------------
PORT="${EYES_PORT:-51823}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "EYES_PORT must be 1-65535, got '$PORT'"
fi
if ss -ltn 2>/dev/null | grep -q ":$PORT " ; then
  warn "port $PORT is already in use on this host"
  warn "  set EYES_PORT to a free port and re-run, e.g.: EYES_PORT=51999 bash"
  die "aborting"
fi
ok "port $PORT is free"

# ---- run container ----------------------------------------------------------
CONTAINER_NAME="${EYES_CONTAINER:-eyes}"
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  step "removing old '$CONTAINER_NAME' container"
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi
step "starting container '$CONTAINER_NAME' on port $PORT"
docker run -d \
  --name "$CONTAINER_NAME" \
  --label app=eyes \
  --restart unless-stopped \
  -p "0.0.0.0:${PORT}:8787" \
  "$IMAGE" >/dev/null
ok "container started"

# ---- health check (10s) -----------------------------------------------------
step "waiting for eyes-mcp to become healthy…"
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok "eyes-mcp is healthy at http://127.0.0.1:${PORT}"
    break
  fi
  sleep 0.5
done
if ! curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  warn "eyes-mcp didn't respond in 10s — try: docker logs $CONTAINER_NAME"
fi

# ---- install the `eyes` CLI to ~/.local/bin ---------------------------------
INSTALL_DIR="${EYES_HOME:-$HOME/.local}"
mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/eyes" <<'CLI'
#!/usr/bin/env bash
# Minimal eyes CLI: talks to the local eyes-mcp container's HTTP API.
#
# This shim is intentionally tool-light. It uses `curl` (always present on
# a system with Docker) and `node` (which the eyes-mcp container requires
# anyway, so any host that ran the install via the published image almost
# certainly has it). We deliberately do NOT depend on `python3` — it isn't
# guaranteed on minimal Linux or stripped-down macOS installs.
#
# If `node` is missing, the one-shot research path prints a clear install
# hint. All other subcommands (doctor, logs, stop/start/restart, upgrade,
# help) work without node.
PORT="${EYES_PORT:-51823}"
HOST="${EYES_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

case "${1:-}" in
  doctor)
    # Pretty-print if we have node, else raw.
    if command -v node >/dev/null 2>&1; then
      curl -fsS "$BASE/health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch{console.log(d)}})'
    else
      curl -fsS "$BASE/health"
    fi
    ;;
  logs) docker logs -f eyes ;;
  stop) docker stop eyes ;;
  start) docker start eyes ;;
  restart) docker restart eyes ;;
  upgrade)
    IMAGE=$(docker inspect --format '{{.Config.Image}}' eyes)
    docker pull "$IMAGE" && docker stop eyes && docker rm eyes
    bash "${EYES_INSTALL:-$(dirname "$0")/install.sh}"
    ;;
  ""|help|-h|--help)
    cat <<HELP
eyes — control the local eyes-mcp container

  eyes              open an interactive research session (calls /mcp)
  eyes "your prompt" one-shot research question
  eyes doctor       show container health + dependencies
  eyes logs         tail container logs
  eyes stop         stop the container
  eyes start        start the container
  eyes restart      restart the container
  eyes upgrade      pull the latest image and restart
HELP
    ;;
  *)
    # One-shot research question via JSON-RPC initialize + tools/call.
    # Requires `node` for JSON encoding/decoding. If absent, fail loud with
    # an actionable hint.
    if ! command -v node >/dev/null 2>&1; then
      echo "eyes: one-shot research needs 'node' to encode the JSON request." >&2
      echo "      Install Node 20+ (https://nodejs.org) or run the install via the 'eyes' shim from a system that has it." >&2
      exit 1
    fi
    PROMPT="$*"
    SESSION=$(curl -sS -i -X POST "$BASE/mcp" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"eyes-cli","version":"0.1.0"}}}' \
      | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2; exit}')
    if [ -z "$SESSION" ]; then
      echo "eyes: failed to initialize MCP session with $BASE" >&2
      exit 1
    fi
    # Build the JSON request body in node, pass the prompt via env to avoid
    # any quote-escaping landmines in the heredoc.
    BODY=$(EYES_PROMPT="$PROMPT" node -e 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"research",arguments:{prompt:process.env.EYES_PROMPT}}}))')
    curl -sS -X POST "$BASE/mcp" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $SESSION" \
      -d "$BODY" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);const t=o.result.content[0].text;const inner=JSON.parse(t);console.log(inner.answer||t)}catch(e){console.log(d)}})'
    ;;
esac
CLI
chmod +x "$INSTALL_DIR/bin/eyes"
ok "installed eyes CLI to $INSTALL_DIR/bin/eyes"

# ---- PATH warning -----------------------------------------------------------
if ! command -v eyes >/dev/null 2>&1; then
  warn "eyes is not on PATH yet. add this to your shell rc:"
  warn "  export PATH=\"$INSTALL_DIR/bin:\$PATH\""
  if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
    if ! grep -q "INSTALL_DIR/bin" "$HOME/.bashrc" 2>/dev/null; then
      printf "\n# eyes-mcp\nexport PATH=\"%s/bin:\$PATH\"\n" "$INSTALL_DIR" >> "$HOME/.bashrc"
      ok "added PATH line to ~/.bashrc (restart shell or run: source ~/.bashrc)"
    fi
  fi
fi

# ---- done -------------------------------------------------------------------
cat <<DONE

${RED}done.${RST}  your setup is complete.

  ${DIM}container${RST}   $CONTAINER_NAME  ${DIM}(auto-restarts on reboot)${RST}
  ${DIM}endpoint${RST}    http://127.0.0.1:$PORT/mcp
  ${DIM}health${RST}      http://127.0.0.1:$PORT/health
  ${DIM}cli${RST}         eyes --help

next:
  eyes "what is the latest on gemma 4 31b?"   ${DIM}# one-shot research${RST}
  eyes setup --help                            ${DIM}# if you want to add an LLM key later${RST}
  eyes doctor                                  ${DIM}# check everything is healthy${RST}

uninstall:
  docker rm -f $CONTAINER_NAME && docker image rm $IMAGE

DONE
