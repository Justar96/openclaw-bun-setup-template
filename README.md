# OpenClaw Railway Template

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/from?repoUrl=https%3A%2F%2Fgithub.com%2FJustar96%2Fopenclaw-bun-setup-template)

I forked this from [vignesh07/clawdbot-railway-template](https://github.com/vignesh07/clawdbot-railway-template) because I wanted a simpler, faster setup. This is a Bun-based Railway template that gets you running OpenClaw with zero command-line work.

## What's in the box

- OpenClaw Gateway + the web UI (served at `/` and `/openclaw`)
- A setup wizard at `/setup` so you can configure everything in the browser
- Persistent storage via Railway Volume (your config and data survive redeploys)
- Export/import for backups (download at `/setup/export` for easy migration later)

## How it works

The service runs a small web server that:
1. Guards the `/setup` endpoint with a password
2. Walks you through onboarding in the browser
3. After setup, reverse-proxies everything to the OpenClaw gateway (WebSockets included)
4. Builds and runs OpenClaw from source during the Docker build so the CLI is available at runtime

## Deploying to Railway

1. Create a new template from this repo (Dockerfile build)
2. Add a **Volume** mounted at `/data`
3. Enable **HTTP Proxy** on port `8080` in Public Networking
4. Set these variables:
   - `SETUP_PASSWORD` — required to access the setup page
   - `PORT=8080` — required and must match the HTTP Proxy port
   - `OPENCLAW_STATE_DIR=/data/.openclaw` (recommended)
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace` (recommended)
   - `OPENCLAW_GATEWAY_TOKEN` (recommended; treat as an admin secret)
5. (Optional) Pin the OpenClaw source ref: `OPENCLAW_GIT_REF=main` (or a tag/commit)
6. Deploy

Then just hit `https://<your-app>.up.railway.app/setup`, finish the wizard, and you're live. The Control UI is at `/openclaw`.

Note: This repo includes a Dockerfile used by Railway and CI for container builds.
Note: Railway domains are created from the UI (Settings → Networking → Generate Domain); they are not auto-provisioned by templates or `railway.json`.

## Getting your bot tokens

**Telegram:**
- Message @BotFather, run `/newbot`, copy the token he gives you

**Discord:**
- Go to https://discord.com/developers/applications
- New Application → Bot tab → Add Bot
- Enable these Privileged Gateway Intents:
  - Message Content Intent (required)
  - Server Members Intent (useful for allowlists)
- Copy the Bot Token
- In OAuth2 → URL Generator, pick scopes `bot` and `applications.commands`, select your permissions, then use that URL to invite the bot to your server

The setup wizard has advanced Discord options too — DM policies, channel/guild restrictions, pairing mode, etc.

## Local testing

**With Bun (fastest for development):**

```bash
# Install dependencies
bun install

# Build OpenClaw and the wrapper
bun run build

# Run in dev mode (no password required for /setup)
bun run dev

# Or run production mode
PORT=8080 SETUP_PASSWORD=test bun run start
```

Then open http://localhost:8080/setup (production mode requires the password)

Tip: `bun run dev` will fetch/build OpenClaw if it's missing, so you can start there without running a separate prepare step.

## Fork note

This started as a fork of [clawdbot-railway-template](https://github.com/vignesh07/clawdbot-railway-template). I rewrote it with Bun and stripped out some complexity to get it running quicker. All credit for the original idea and Railway integration goes to Vignesh N — I'm just maintaining this variant.
