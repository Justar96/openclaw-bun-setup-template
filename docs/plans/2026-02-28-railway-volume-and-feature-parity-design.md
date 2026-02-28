# Railway Volume Access & Feature Parity Design

Date: 2026-02-28
Status: Approved

## Goal

Port 11 missing features from the reference Node.js/Express implementation into the current Bun-native architecture, ensuring:
- Full persistent volume access at `/data` (like a home directory)
- Runtime update support via pnpm
- Security parity with the reference (dashboard auth, token injection)
- Proper startup lifecycle (token sync, bootstrap hook, doctor --fix)

## Approach

Surgical port (A) + Node.js/pnpm hybrid runtime (C). Keep the Bun-native server architecture but add Node.js + pnpm to the runtime image for openclaw update support.

## Changes by File

### 1. Dockerfile (runtime stage)

Add to the runtime stage:
- Install Node.js 22, pnpm (via corepack), tini, python3, python3-venv
- Set npm/pnpm persistence env vars under `/data`:
  - `NPM_CONFIG_PREFIX=/data/npm`
  - `NPM_CONFIG_CACHE=/data/npm-cache`
  - `PNPM_HOME=/data/pnpm`
  - `PNPM_STORE_DIR=/data/pnpm-store`
  - `PATH="/data/npm/bin:/data/pnpm:${PATH}"`
- Use `tini` as PID 1: `ENTRYPOINT ["tini", "--"]`

### 2. src/config.ts

- `ensureDirectories()`: Also create `STATE_DIR/credentials/` and chmod STATE_DIR to 0700

### 3. src/server.ts

#### 3a. Dashboard proxy auth (SECURITY)
Before proxying non-/setup requests, check Basic auth using the same `checkSetupAuth()`. Exempt `/setup/healthz`.

#### 3b. Gateway token injection
In `proxyToGateway()`, inject `Authorization: Bearer <token>` when the request has no auth header. Same for WebSocket upstream connections.

#### 3c. Onboarding additions in `handleApiRun()`
After successful onboarding, also set:
- `gateway.remote.token` = OPENCLAW_GATEWAY_TOKEN
- `gateway.trustedProxies` = `["127.0.0.1"]`
- Run `openclaw doctor --fix` after channel configuration

#### 3d. Startup lifecycle
At server start (after `Bun.serve()`):
- Call `ensureDirectories()` to set permissions
- Call `syncGatewayTokens()` to re-sync config with env vars
- Call `runBootstrapHook()` to run bootstrap.sh if it exists
- Auto-start gateway if already configured

### 4. src/gateway.ts

#### 4a. `syncGatewayTokens()`
On every boot, re-sync config file gateway tokens with current env var:
- `gateway.auth.mode` = token
- `gateway.auth.token` = OPENCLAW_GATEWAY_TOKEN
- `gateway.remote.token` = OPENCLAW_GATEWAY_TOKEN

#### 4b. `runBootstrapHook()`
If `$WORKSPACE_DIR/bootstrap.sh` exists, run it with a 10-minute timeout before starting the gateway.

## Items NOT included

- Auto-bump CI workflow (user prefers manual updates)
- Legacy config migration (clawdbot.json/moltbot.json rename)
- Device management endpoints (replaced by pairing system)
- Plugin console commands (existing pairing commands sufficient)
- /setup/api/auth-groups fast endpoint (minor optimization)

## Security impact

- Dashboard auth: Control UI at `/openclaw` will require SETUP_PASSWORD (Basic auth)
- Token injection: Browser UI will auto-authenticate to the gateway
- Trusted proxies: Railway reverse proxy headers will be properly handled
- Startup token sync: Prevents token mismatch errors after env var changes
