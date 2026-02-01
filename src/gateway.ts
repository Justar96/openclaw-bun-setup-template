import childProcess, { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";

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
} from "./config.js";

// ============================================================================
// Gateway State
// ============================================================================

const state: GatewayState = {
  proc: null,
  starting: null,
};

/**
 * Get the current gateway process.
 */
export function getGatewayProc(): ChildProcess | null {
  return state.proc;
}

/**
 * Set the gateway process to null (for external cleanup).
 */
export function clearGatewayProc(): void {
  state.proc = null;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Run a command and capture its output.
 */
export function runCmd(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: getChildEnv(),
    });

    let out = "";
    proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));

    proc.on("error", (err: Error) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code: number | null) => resolve({ code: code ?? 0, output: out }));
  });
}

// ============================================================================
// Gateway Health Check
// ============================================================================

/**
 * Wait for the gateway to become ready by polling health endpoints.
 */
async function waitForGatewayReady(opts: WaitForGatewayOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    // Try the default Control UI base path, then fall back to legacy or root.
    const paths = ["/openclaw", "/clawdbot", "/"];
    
    for (const p of paths) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
        // Any HTTP response means the port is open.
        if (res) return true;
      } catch {
        // try next
      }
    }
    
    await sleep(250);
  }
  
  return false;
}

// ============================================================================
// Gateway Lifecycle
// ============================================================================

/**
 * Start the gateway process.
 */
async function startGateway(): Promise<void> {
  if (state.proc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

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

  state.proc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: getChildEnv(),
  });

  state.proc.on("error", (err: Error) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    state.proc = null;
  });

  state.proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    state.proc = null;
  });
}

/**
 * Ensure the gateway is running, starting it if necessary.
 */
export async function ensureGatewayRunning(): Promise<GatewayResult> {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (state.proc) return { ok: true };
  
  if (!state.starting) {
    state.starting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      state.starting = null;
    });
  }
  
  await state.starting;
  return { ok: true };
}

/**
 * Stop the gateway if running, then restart it.
 */
export async function restartGateway(): Promise<GatewayResult> {
  if (state.proc) {
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

/**
 * Stop the gateway if running.
 */
export async function stopGateway(): Promise<void> {
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

/**
 * Gracefully shutdown the gateway (for process exit).
 */
export function shutdownGateway(): void {
  try {
    if (state.proc) {
      state.proc.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// Config File Operations
// ============================================================================

/**
 * Read the raw config file content.
 */
export function readConfigFile(configFilePath: string): { exists: boolean; content: string } {
  const exists = fs.existsSync(configFilePath);
  const content = exists ? fs.readFileSync(configFilePath, "utf8") : "";
  return { exists, content };
}

/**
 * Write the config file with automatic backup.
 */
export function writeConfigFile(configFilePath: string, content: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  
  // Backup existing config
  if (fs.existsSync(configFilePath)) {
    const backupPath = `${configFilePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(configFilePath, backupPath);
  }
  
  fs.writeFileSync(configFilePath, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * Delete the config file (for reset).
 */
export function deleteConfigFile(configFilePath: string): void {
  fs.rmSync(configFilePath, { force: true });
}
