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

1. Click the **Deploy on Railway** button above
2. Set these variables when prompted:
   - `SETUP_PASSWORD` — required to access the setup page
   - `OPENCLAW_GATEWAY_TOKEN` — any random string (treat as admin secret)
3. After deploy, go to your service in the Railway dashboard and:
   - **Add a Volume** mounted at **`/data`** (Settings → Volumes → Add Volume → mount path `/data`)
   - **Generate a domain** (Settings → Networking → Generate Domain)
4. Railway will redeploy automatically after adding the volume
5. Open `https://<your-domain>.up.railway.app/setup`, finish the wizard, and you're live

> **Important:** The volume at `/data` is required. Without it, all config, workspace data, and updates are lost on every redeploy.

The Control UI is at `/openclaw` after setup.

Note: Railway domains and volumes must be added from the dashboard — they cannot be auto-provisioned from `railway.json`.

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
