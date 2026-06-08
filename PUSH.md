# Push to GitHub

This repo is initialized and committed locally on `main`. To push to a public GitHub repo, do one of the following.

## Option A: GitHub CLI (easiest)

```bash
# 1. Install gh if you don't have it
#    macOS:  brew install gh
#    Linux:  https://github.com/cli/cli#installation
#    Win:    winget install --id GitHub.cli

# 2. Authenticate (will open a browser)
gh auth login

# 3. From inside the repo:
gh repo create eyes-mcp --public --source=. --remote=origin --push \
  --description "Research MCP server for AI agents. Docker-packaged. Swarm-ready. Gemma 4 31B main agent with 10 source adapters (SearXNG, Crawl4AI, GitHub, Reddit, YouTube, HN, arXiv, Wikipedia, OSM, generic)."
```

## Option B: HTTPS + personal access token

```bash
# 1. Create an empty public repo on https://github.com/new
#    Name: eyes-mcp
#    Do NOT initialize with README, license, or .gitignore (we have them all)

# 2. Add the remote and push
cd /home/ubuntu/workspace/Eyes-MCP
git remote add origin https://github.com/<your-username>/eyes-mcp.git
git push -u origin main

# If the remote repo was created with a README/license (and main has commits):
# git pull --rebase origin main
# git push -u origin main
```

When prompted, use a personal access token (not your password).
Create one at: https://github.com/settings/tokens/new
- Scopes: `repo` (public_repo is enough for public repos)

## Option C: SSH

```bash
# 1. Generate a key if you don't have one
ssh-keygen -t ed25519 -C "your_email@example.com"
cat ~/.ssh/id_ed25519.pub   # add this to https://github.com/settings/keys

# 2. Create the empty repo on github.com (same as Option B step 1)

# 3. Add the remote and push
cd /home/ubuntu/workspace/Eyes-MCP
git remote add origin git@github.com:<your-username>/eyes-mcp.git
git push -u origin main
```

## After pushing

1. Visit `https://github.com/<your-username>/eyes-mcp/settings` and:
   - Add topics: `mcp`, `model-context-protocol`, `research`, `agent`, `claude`, `gemini`, `typescript`, `docker`
   - Enable Issues (default)
   - Optional: enable Discussions, Sponsorship, Wiki

2. **Register in the MCP Registry** (the official listing surface for MCP servers):
   - Repo: https://github.com/modelcontextprotocol/registry
   - Quickstart: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
   - One PR adds your server to `https://registry.modelcontextprotocol.io`

3. First release (optional, for visibility):
   ```bash
   git tag -a v0.1.0 -m "v0.1.0: initial public release"
   git push origin v0.1.0
   ```

## Local state

- Branch: `main`
- Latest commit: `00d9318 feat: initial Eyes-MCP — research MCP server`
- 50 files, 4487 LOC across 32 .ts source files (plus tests)
- Clean working tree
- No secrets in the commit (SearXNG `secret_key` is a placeholder; no API tokens)
