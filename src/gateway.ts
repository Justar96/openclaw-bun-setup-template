import childProcess, { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CommandResult, GatewayResult, GatewayState, WaitForGatewayOptions } from "./types.js";
import { sleep } from "./utils.js";
import {
  clawArgs,
  ensureDirectories,
  getChildEnv,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_PORT,
  isConfigured,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_NODE,
  STATE_DIR,
  WORKSPACE_DIR,
} from "./config.js";

// Circuit breaker / crash tracking configuration
const CRASH_WINDOW_MS = 60_000;           // Track crashes within 1 minute
const MAX_CRASHES_IN_WINDOW = 5;          // Max crashes before circuit opens
const CIRCUIT_RESET_MS = 120_000;         // Wait 2 minutes before retrying after circuit opens
const MAX_CONSECUTIVE_FAILS = 3;          // Max consecutive startup failures
const BASE_BACKOFF_MS = 1_000;            // Base backoff delay
const MAX_BACKOFF_MS = 30_000;            // Max backoff delay
const HEALTH_CHECK_INTERVAL_MS = 30_000;  // Health check every 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 5_000;    // Timeout for health check requests

const state: GatewayState = {
  proc: null,
  starting: null,
  crashHistory: [],
  consecutiveFails: 0,
  circuitOpen: false,
  circuitOpenedAt: null,
  lastHealthCheck: null,
  healthCheckTimer: null,
};

function mergeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...getChildEnv(),
    ...(extra ?? {}),
  };
}

/** Return the current gateway child process. */
export function getGatewayProc(): ChildProcess | null {
  return state.proc;
}

/** Clear the cached gateway process reference. */
export function clearGatewayProc(): void {
  state.proc = null;
}

/** Calculate exponential backoff delay with jitter. */
function calculateBackoff(attempt: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.random() * 0.3 * exponential; // Add up to 30% jitter
  return Math.floor(exponential + jitter);
}

/** Record a crash and check if circuit should open. */
function recordCrash(): void {
  const now = Date.now();
  state.crashHistory.push(now);
  
  // Prune old crashes outside the window
  state.crashHistory = state.crashHistory.filter(t => now - t < CRASH_WINDOW_MS);
  
  console.error(`[gateway] crash recorded (${state.crashHistory.length} in last ${CRASH_WINDOW_MS / 1000}s)`);
  
  // Open circuit if too many crashes
  if (state.crashHistory.length >= MAX_CRASHES_IN_WINDOW) {
    state.circuitOpen = true;
    state.circuitOpenedAt = now;
    console.error(`[gateway] CIRCUIT BREAKER OPEN: ${state.crashHistory.length} crashes in ${CRASH_WINDOW_MS / 1000}s. Will retry after ${CIRCUIT_RESET_MS / 1000}s`);
  }
}

/** Check if circuit breaker allows starting. */
function checkCircuitBreaker(): { allowed: boolean; reason?: string } {
  if (!state.circuitOpen) {
    return { allowed: true };
  }
  
  const now = Date.now();
  const elapsed = now - (state.circuitOpenedAt ?? 0);
  
  if (elapsed >= CIRCUIT_RESET_MS) {
    // Reset circuit breaker (half-open state)
    console.log(`[gateway] circuit breaker reset after ${elapsed / 1000}s cooldown`);
    state.circuitOpen = false;
    state.circuitOpenedAt = null;
    state.crashHistory = [];
    state.consecutiveFails = 0;
    return { allowed: true };
  }
  
  const remaining = Math.ceil((CIRCUIT_RESET_MS - elapsed) / 1000);
  return {
    allowed: false,
    reason: `Circuit breaker open due to repeated failures. Retry in ${remaining}s`,
  };
}

/** Start health check monitoring. */
function startHealthMonitor(): void {
  stopHealthMonitor();
  
  state.healthCheckTimer = setInterval(async () => {
    if (!state.proc) return;
    
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      
      const res = await fetch(`${GATEWAY_TARGET}/`, {
        method: "GET",
        signal: controller.signal,
      });
      
      clearTimeout(timer);
      
      if (res.ok || res.status < 500) {
        state.lastHealthCheck = Date.now();
        state.consecutiveFails = 0; // Reset on healthy response
      }
    } catch {
      console.warn(`[gateway] health check failed`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Stop health check monitoring. */
function stopHealthMonitor(): void {
  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer);
    state.healthCheckTimer = null;
  }
}

/** Get current gateway health status. */
export function getGatewayHealth(): {
  running: boolean;
  circuitOpen: boolean;
  crashCount: number;
  consecutiveFails: number;
  lastHealthCheck: number | null;
} {
  return {
    running: state.proc !== null,
    circuitOpen: state.circuitOpen,
    crashCount: state.crashHistory.length,
    consecutiveFails: state.consecutiveFails,
    lastHealthCheck: state.lastHealthCheck,
  };
}

export interface RunCmdOptions extends SpawnOptions {
  timeoutMs?: number;
}

/** Run a command and capture stdout/stderr into a single buffer. */
export function runCmd(cmd: string, args: string[], opts: RunCmdOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const { env: extraEnv, timeoutMs, ...spawnOpts } = opts;
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: mergeEnv(extraEnv),
    });

    let out = "";
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        out += `\n[timeout] Command killed after ${timeoutMs}ms\n`;
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));

    proc.on("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      const exitCode = killed ? 124 : (code ?? (signal ? 1 : 0));
      resolve({ code: exitCode, output: out });
    });
  });
}

/** Wait for the gateway to become reachable by polling known endpoints. */
async function waitForGatewayReady(opts: WaitForGatewayOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 2_000;
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    const paths = ["/openclaw", "/clawdbot", "/"];
    
    for (const p of paths) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET", signal: controller.signal });
        if (res) return true;
      } catch {
        // Try the next path.
      } finally {
        clearTimeout(timer);
      }
    }
    
    await sleep(250);
  }
  
  return false;
}

/** Start the gateway process if it is not already running. */
async function startGateway(): Promise<void> {
  if (state.proc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  // Check circuit breaker before starting
  const circuit = checkCircuitBreaker();
  if (!circuit.allowed) {
    throw new Error(circuit.reason);
  }

  // Apply backoff if we have consecutive failures
  if (state.consecutiveFails > 0) {
    const backoff = calculateBackoff(state.consecutiveFails);
    console.log(`[gateway] applying ${backoff}ms backoff (attempt ${state.consecutiveFails + 1})`);
    await sleep(backoff);
  }

  ensureDirectories();

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  const startTime = Date.now();

  state.proc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: getChildEnv(),
  });

  state.proc.on("error", (err: Error) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    stopHealthMonitor();
    state.consecutiveFails++;
    recordCrash();
    state.proc = null;
  });

  state.proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    const runtime = Date.now() - startTime;
    console.error(`[gateway] exited code=${code} signal=${signal} after ${runtime}ms`);
    stopHealthMonitor();
    
    // Only count as crash if it exited quickly with an error
    // (not a clean shutdown from SIGTERM)
    if (signal !== "SIGTERM" && signal !== "SIGINT") {
      if (code !== 0 || runtime < 10_000) {
        // Crashed or exited too quickly (likely startup failure)
        state.consecutiveFails++;
        recordCrash();
      } else {
        // Ran for a while before exiting - reset failure counter
        state.consecutiveFails = 0;
      }
    }
    
    state.proc = null;
  });

  // Start health monitoring after spawn
  startHealthMonitor();
}

/** Ensure the gateway is running, starting it when needed. */
export async function ensureGatewayRunning(): Promise<GatewayResult> {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (state.proc) return { ok: true };
  
  // Check circuit breaker first
  const circuit = checkCircuitBreaker();
  if (!circuit.allowed) {
    return { ok: false, reason: circuit.reason };
  }
  
  // Check consecutive failures
  if (state.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    const msg = `Too many consecutive startup failures (${state.consecutiveFails}). Use gateway.restart to force retry.`;
    console.error(`[gateway] ${msg}`);
    return { ok: false, reason: msg };
  }
  
  if (!state.starting) {
    state.starting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        state.consecutiveFails++;
        recordCrash();
        throw new Error("Gateway did not become ready in time");
      }
      // Success - reset failure counter
      state.consecutiveFails = 0;
      state.lastHealthCheck = Date.now();
      console.log(`[gateway] started successfully`);
    })().finally(() => {
      state.starting = null;
    });
  }
  
  try {
    await state.starting;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** Stop the gateway if running, then restart it. */
export async function restartGateway(): Promise<GatewayResult> {
  // Reset circuit breaker and failure counters on explicit restart
  state.circuitOpen = false;
  state.circuitOpenedAt = null;
  state.consecutiveFails = 0;
  state.crashHistory = [];
  console.log(`[gateway] restart requested - resetting circuit breaker`);
  
  if (state.proc) {
    stopHealthMonitor();
    try {
      state.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    state.proc = null;
  }
  return ensureGatewayRunning();
}

/** Stop the gateway if running. */
export async function stopGateway(): Promise<void> {
  stopHealthMonitor();
  if (state.proc) {
    try {
      state.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await sleep(750);
    state.proc = null;
  }
}

/** Best-effort shutdown used during wrapper process exit. */
export function shutdownGateway(): void {
  stopHealthMonitor();
  try {
    if (state.proc) {
      state.proc.kill("SIGTERM");
    }
  } catch {
    // Ignore shutdown errors on exit.
  }
}

/** Reset circuit breaker and failure counters (for manual recovery). */
export function resetCircuitBreaker(): void {
  state.circuitOpen = false;
  state.circuitOpenedAt = null;
  state.consecutiveFails = 0;
  state.crashHistory = [];
  console.log(`[gateway] circuit breaker manually reset`);
}

/** Read the raw config file content. */
export function readConfigFile(configFilePath: string): { exists: boolean; content: string } {
  const exists = fs.existsSync(configFilePath);
  const content = exists ? fs.readFileSync(configFilePath, "utf8") : "";
  return { exists, content };
}

/** Write a config file and save a timestamped backup when overwriting. */
export function writeConfigFile(configFilePath: string, content: string): void {
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  
  // Preserve the last config in case the new write is invalid.
  if (fs.existsSync(configFilePath)) {
    const backupPath = `${configFilePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(configFilePath, backupPath);
  }
  
  fs.writeFileSync(configFilePath, content, { encoding: "utf8", mode: 0o600 });
}

/** Delete the config file during reset. */
export function deleteConfigFile(configFilePath: string): void {
  fs.rmSync(configFilePath, { force: true });
}

/** Re-sync gateway tokens in the config file with the current env var.
 *  Prevents token mismatch errors after Railway variable updates. */
export async function syncGatewayTokens(): Promise<void> {
  if (!isConfigured()) return;
  console.log("[gateway] syncing gateway tokens with current env");
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
}

/** Configure gateway settings for Railway proxy deployment and clear stale pairing state.
 *
 *  Behind a reverse proxy the device pairing system is redundant — our proxy
 *  authenticates via SETUP_PASSWORD before forwarding to the gateway.  We:
 *  1. Disable device auth for Control UI so browser connections skip pairing entirely.
 *  2. Delete stale pending pairing files that may contain poisoned silent=false entries
 *     from earlier runs (the merge logic ANDs the silent flag, so one bad entry blocks
 *     all future auto-approvals). */
export async function syncGatewayConfig(): Promise<void> {
  if (!isConfigured()) return;
  console.log("[gateway] syncing gateway config for proxy deployment");

  // Skip device identity checks for Control UI (our proxy handles auth).
  await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true",
  ]));

  // Clear stale pending device/node pairings before gateway start.
  // These files may contain requests with silent=false from when the gateway
  // ran under Bun (remoteAddress was undefined → isLocalClient=false).
  const stalePaths = [
    path.join(STATE_DIR, "devices", "pending.json"),
    path.join(STATE_DIR, "nodes", "pending.json"),
  ];
  for (const p of stalePaths) {
    try {
      fs.unlinkSync(p);
      console.log(`[gateway] removed stale pairing file: ${p}`);
    } catch {
      // File doesn't exist yet — expected on first run.
    }
  }
}

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
