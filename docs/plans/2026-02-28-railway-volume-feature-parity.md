# Railway Volume & Feature Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port 11 missing features from the reference implementation so OpenClaw has full persistent volume access, runtime update support, proper security, and correct startup lifecycle on Railway.

**Architecture:** Surgical edits to 4 existing files (Dockerfile, config.ts, server.ts, gateway.ts). No new source files. Keep the Bun-native server architecture; add Node.js+pnpm to the runtime image for `openclaw update` support.

**Tech Stack:** Bun, Node.js 22, pnpm 10, tini, TypeScript

---

### Task 1: Dockerfile — Add Node.js, pnpm, tini, and volume persistence env vars

**Files:**
- Modify: `Dockerfile:29-55` (runtime stage)

**Step 1: Edit the runtime stage**

Replace lines 29-55 with:

```dockerfile
FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install Node.js 22 (for openclaw CLI runtime), pnpm (for openclaw update),
# tini (PID 1 zombie reaping), python3 (for openclaw plugins).
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl tini python3 python3-venv \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && corepack enable && corepack prepare pnpm@10 --activate \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw ./openclaw
COPY --from=build /app/src/ui ./src/ui

# Persist npm/pnpm state under /data so openclaw update survives redeploys.
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# Prepare persistent data directory for Railway volume mount.
RUN mkdir -p /data/.openclaw /data/workspace /data/npm /data/pnpm /data/pnpm-store /data/npm-cache \
  && chown -R bun:bun /data

ENV PORT=8080
ENV OPENCLAW_PUBLIC_PORT=8080
ENV OPENCLAW_NODE=bun
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "dist/server.js"]
```

**Step 2: Verify the Dockerfile is valid**

Run: `docker build --target runtime --no-cache -f Dockerfile . 2>&1 | tail -5` (or just `bun run lint` for the TS side)
Expected: Build should parse without syntax errors (the full build needs network access, so a parse check is sufficient locally).

**Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): add Node.js, pnpm, tini, and volume persistence env vars

Add Node.js 22 and pnpm to runtime image for openclaw update support.
Use tini as PID 1 for zombie reaping and signal forwarding.
Set npm/pnpm paths under /data for persistence across redeploys."
```

---

### Task 2: config.ts — Harden ensureDirectories with credentials dir and chmod

**Files:**
- Modify: `src/config.ts:125-129` (ensureDirectories function)

**Step 1: Update ensureDirectories**

Replace the `ensureDirectories` function at lines 125-129 with:

```typescript
/** Ensure state and workspace directories exist on disk with secure permissions. */
export function ensureDirectories(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {
    // Best-effort: volume filesystems may not support chmod.
  }
}
```

**Step 2: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): create credentials dir and chmod STATE_DIR on startup"
```

---

### Task 3: gateway.ts — Add syncGatewayTokens and runBootstrapHook

**Files:**
- Modify: `src/gateway.ts` (add two new exported functions, add WORKSPACE_DIR import)

**Step 1: Add WORKSPACE_DIR to the import from config.ts**

At line 7-16, update the import block to include `WORKSPACE_DIR`:

```typescript
import {
  clawArgs,
  ensureDirectories,
  getChildEnv,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_PORT,
  isConfigured,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_NODE,
  WORKSPACE_DIR,
} from "./config.js";
```

**Step 2: Add syncGatewayTokens function**

Add after `deleteConfigFile` (after line 432):

```typescript
/** Re-sync gateway tokens in the config file with the current env var.
 *  Prevents token mismatch errors after Railway variable updates. */
export async function syncGatewayTokens(): Promise<void> {
  if (!isConfigured()) return;
  console.log("[gateway] syncing gateway tokens with current env");
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
}
```

**Step 3: Add runBootstrapHook function**

Add after `syncGatewayTokens`:

```typescript
/** Run $WORKSPACE_DIR/bootstrap.sh if it exists (10 minute timeout). */
export async function runBootstrapHook(): Promise<void> {
  const script = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (!fs.existsSync(script)) return;
  console.log("[wrapper] running bootstrap.sh...");
  const result = await runCmd("bash", [script], { timeoutMs: 600_000 });
  console.log(`[wrapper] bootstrap.sh exited code=${result.code}`);
  if (result.output) {
    console.log(`[wrapper] bootstrap.sh output:\n${result.output}`);
  }
}
```

**Step 4: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/gateway.ts
git commit -m "feat(gateway): add syncGatewayTokens and runBootstrapHook

syncGatewayTokens re-syncs config file tokens with the current env var
on every boot, preventing mismatch errors after Railway variable updates.

runBootstrapHook runs bootstrap.sh from the workspace dir on startup."
```

---

### Task 4: server.ts — Add dashboard auth, token injection, and onboarding fixes

**Files:**
- Modify: `src/server.ts` (multiple sections)

**Step 4a: Add syncGatewayTokens and runBootstrapHook to imports**

At lines 45-56, update the gateway.js import to include the new functions:

```typescript
import {
  deleteConfigFile,
  ensureGatewayRunning,
  getGatewayHealth,
  readConfigFile,
  resetCircuitBreaker,
  restartGateway,
  runBootstrapHook,
  runCmd,
  shutdownGateway,
  stopGateway,
  syncGatewayTokens,
  writeConfigFile,
} from "./gateway.js";
```

**Step 4b: Add gateway token injection to proxyToGateway**

In `proxyToGateway` at line 780, after `const headers = buildProxyHeaders(req, server);`, add:

```typescript
  // Inject gateway token for requests without an auth header so the
  // browser Control UI can connect without pasting the token.
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
```

**Step 4c: Add gateway token injection to WebSocket upstream**

In the `websocket.open` handler at line 927, after `const { headers, protocols } = buildWsClientOptions(data.headers);`, add:

```typescript
        // Inject gateway token for WebSocket connections without auth.
        if (!headers["authorization"]) {
          headers["authorization"] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
        }
```

**Step 4d: Fix onboarding — add remote.token, trustedProxies, doctor --fix**

In `handleApiRun`, at lines 324-328, after the existing config set calls, add the missing ones:

```typescript
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));
```

Then, after the channel configuration block (after line 344) and before `await restartGateway();`, add doctor --fix:

```typescript
      // Activate plugins and fix any config issues.
      const doctor = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      extra += `\n[doctor --fix] exit=${doctor.code}\n${doctor.output || "(no output)"}`;
```

**Step 4e: Add dashboard auth to proxied requests**

In the main `fetch` handler, at line 872 (WebSocket upgrade section), add auth check before the gateway running check:

```typescript
    // Handle WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!isConfigured()) {
        return new Response("Not configured", { status: 503 });
      }

      // Require auth for WebSocket connections (protects Control UI).
      const wsAuthErr = checkSetupAuth(req);
      if (wsAuthErr) return wsAuthErr;

      try {
```

At lines 904-918 (the proxy fallthrough after route matching), add auth check before proxying:

```typescript
    // Redirect to /setup if not configured
    if (!isConfigured() && !pathname.startsWith("/setup")) {
      return redirect("/setup");
    }

    // Require auth for all proxied requests (protects Control UI).
    // Exempt /healthz which is a public health probe.
    if (pathname !== "/healthz") {
      const dashAuthErr = checkSetupAuth(req);
      if (dashAuthErr) return dashAuthErr;
    }

    // Proxy to gateway
    if (isConfigured()) {
```

**Step 4f: Add startup lifecycle after Bun.serve**

Replace lines 1004-1017 (the startup logging block) with:

```typescript
// --- Startup lifecycle ---

console.log(`[wrapper] running on Bun ${Bun.version}`);
console.log(`[wrapper] listening on :${PORT}`);
console.log(`[wrapper] state dir: ${STATE_DIR}`);
console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);

if (DEV_MODE) {
  console.log("[wrapper] DEV_MODE: auth bypass enabled for /setup");
} else if (!SETUP_PASSWORD) {
  console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
}

// Startup lifecycle: ensure directories, sync tokens, run bootstrap, auto-start gateway.
(async () => {
  try {
    ensureDirectories();
    await syncGatewayTokens();
    await runBootstrapHook();
    if (isConfigured()) {
      console.log("[wrapper] auto-starting gateway (already configured)");
      await ensureGatewayRunning();
    }
  } catch (err) {
    console.error("[wrapper] startup lifecycle error:", err);
  }
})();
```

**Step 4g: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No errors.

**Step 4h: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): add dashboard auth, token injection, startup lifecycle

- Protect all proxied requests with SETUP_PASSWORD (Basic auth)
- Inject gateway token into proxied HTTP/WS requests without auth
- Set gateway.remote.token and gateway.trustedProxies on onboarding
- Run doctor --fix after channel configuration
- Add startup lifecycle: ensureDirectories, syncGatewayTokens,
  runBootstrapHook, auto-start gateway if already configured"
```

---

### Task 5: Typecheck, build, and verify

**Files:**
- All modified files

**Step 1: Run full typecheck**

Run: `bun x tsc --noEmit`
Expected: No errors.

**Step 2: Run build**

Run: `OPENCLAW_SKIP_BUILD=1 bun run build`
Expected: Build succeeds, `dist/server.js` is produced.

**Step 3: Run smoke test (if openclaw binary is available)**

Run: `bun scripts/smoke.js` (may fail locally if openclaw isn't built; that's OK)

**Step 4: Commit any remaining changes**

```bash
git status
# If any remaining changes, stage and commit
```

---

### Task 6: Deploy to Railway and verify

**Step 1: Push to GitHub**

```bash
git push origin main
```

**Step 2: Deploy**

```bash
railway up --service openclaw --ci -m "feature parity: volume persistence, auth, lifecycle"
```

**Step 3: Verify deployment**

```bash
railway logs --service openclaw --lines 50
```

Expected log output should include:
- `[wrapper] running on Bun ...`
- `[gateway] syncing gateway tokens with current env`
- `[wrapper] auto-starting gateway (already configured)` (if previously configured)

**Step 4: Verify healthcheck**

```bash
curl -s https://openclaw-production-291b.up.railway.app/setup/healthz
```

Expected: `{"ok":true}`

**Step 5: Verify dashboard auth**

```bash
curl -s https://openclaw-production-291b.up.railway.app/openclaw
```

Expected: 401 Unauthorized (since no password was provided).

```bash
curl -s -u ":idbA6XUP3lVbdCooBcjO" https://openclaw-production-291b.up.railway.app/openclaw
```

Expected: Proxied response from the gateway (or redirect to setup if not configured yet).
