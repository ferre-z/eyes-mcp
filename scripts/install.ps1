# =============================================================================
# Eyes-MCP — one-line installer (Windows / PowerShell 5+)
#
# Usage (from an elevated PowerShell, or with winget-installed docker):
#   irm https://raw.githubusercontent.com/ferre-z/eyes-mcp/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Verifies Docker is installed (or tells you to install Docker Desktop)
#   2. Pulls the eyes-mcp image
#   3. Starts the container in the background
#   4. Installs the `eyes` shim to ~\bin
#   5. Prints a summary
# =============================================================================

$ErrorActionPreference = 'Stop'

function Step($msg)  { Write-Host "▸ $msg" -ForegroundColor DarkRed }
function Ok($msg)    { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "! $msg" -ForegroundColor Yellow }
function Die($msg)   { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ---- banner -----------------------------------------------------------------
@'

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

'@ | Write-Host

# ---- docker check -----------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die "docker not found. install Docker Desktop from https://docker.com/products/docker-desktop and re-run."
}
try {
  $null = docker info 2>&1
  if ($LASTEXITCODE -ne 0) { throw "docker not responding" }
} catch {
  Die "docker is installed but not responding. start Docker Desktop and re-run."
}
Ok "docker is responding"

# ---- pull image -------------------------------------------------------------
$Image = if ($env:EYES_IMAGE) { $env:EYES_IMAGE } else { "ghcr.io/ferre-z/eyes-mcp:0.1.0" }
Step "pulling $Image"
docker pull --quiet $Image | Out-Null
Ok "image pulled"

# ---- port -------------------------------------------------------------------
$Port = if ($env:EYES_PORT) { [int]$env:EYES_PORT } else { 51823 }
$inUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($inUse) {
  Warn "port $Port is already in use"
  Die "set `$env:EYES_PORT to a free port and re-run, e.g.: `$env:EYES_PORT=51999; iex ((irm ...))"
}
Ok "port $Port is free"

# ---- run container ----------------------------------------------------------
$Container = if ($env:EYES_CONTAINER) { $env:EYES_CONTAINER } else { "eyes" }
$existing = docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $Container }
if ($existing) {
  Step "removing old container '$Container'"
  docker rm -f $Container | Out-Null
}
Step "starting container '$Container' on port $Port"
docker run -d `
  --name $Container `
  --label app=eyes `
  --restart unless-stopped `
  -p "0.0.0.0:${Port}:8787" `
  $Image | Out-Null
Ok "container started"

# ---- health check (10s) -----------------------------------------------------
Step "waiting for eyes-mcp to become healthy…"
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $null = Invoke-RestMethod "http://127.0.0.1:${Port}/health" -TimeoutSec 2
    $ok = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if ($ok) { Ok "eyes-mcp is healthy at http://127.0.0.1:${Port}" }
else { Warn "eyes-mcp didn't respond in 10s — try: docker logs $Container" }

# ---- eyes shim to ~\bin -----------------------------------------------------
$InstallDir = if ($env:EYES_HOME) { $env:EYES_HOME } else { Join-Path $HOME ".local" }
$BinDir = Join-Path $InstallDir "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shim = @"
@echo off
setlocal
set "PORT=51823"
if defined EYES_PORT set "PORT=%EYES_PORT%"
set "BASE=http://127.0.0.1:%PORT%"
if "%1"=="doctor" (
  powershell -Command "try { (Invoke-WebRequest '%BASE%/health' -UseBasicParsing -TimeoutSec 5).Content } catch { Write-Host 'not healthy' }"
) else if "%1"=="logs" (
  docker logs -f eyes
) else if "%1"=="stop" (
  docker stop eyes
) else if "%1"=="start" (
  docker start eyes
) else if "%1"=="restart" (
  docker restart eyes
) else if "%1"=="" goto help
goto end
:help
echo eyes — control the local eyes-mcp container
echo.
echo   eyes "your prompt"   one-shot research
echo   eyes doctor         show health
echo   eyes logs           tail logs
echo   eyes stop / start
: end
endlocal
"@
$shimPath = Join-Path $BinDir "eyes.cmd"
Set-Content -Path $shimPath -Value $shim -Encoding ASCII
Ok "installed eyes shim to $shimPath"

# ---- PATH warning -----------------------------------------------------------
$envPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($envPath -notlike "*$BinDir*") {
  Warn "eyes is not on your PATH yet"
  Warn "  add it:  setx Path `"$BinDir;%Path%`""
}

# ---- done -------------------------------------------------------------------
@"

done.  your setup is complete.

  container : $Container  (auto-restarts on reboot)
  endpoint  : http://127.0.0.1:$Port/mcp
  health    : http://127.0.0.1:$Port/health
  cli       : $shimPath

next:
  eyes "what is the latest on gemma 4 31b?"      one-shot research
  eyes setup --help                              re-run the wizard

uninstall:
  docker rm -f $Container
  docker image rm $Image

"@ | Write-Host
