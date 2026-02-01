import childProcess, { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CommandResult, GatewayResult, GatewayState, WaitForGatewayOptions } from "./types.js";
import { sleep } from "./utils.js";
import {
  clawArgs,
  configPath,
  ensureDirectories,
  getChildEnv,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_PORT,
  isConfigured,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_NODE,
} from "./config.js";

const state: GatewayState = {
  proc: null,
  starting: null,
};

function mergeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...getChildEnv(),
    ...(extra ?? {}),
  };
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateProcess(proc: ChildProcess, timeoutMs = 2_000): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // Ignore failures; the process may already be gone.
  }
  const exited = await waitForExit(proc, timeoutMs);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore if force-kill is not available.
    }
    await waitForExit(proc, 1_000);
  }
}

/** Return the current gateway child process. */
export function getGatewayProc(): ChildProcess | null {
  return state.proc;
}

/** Clear the cached gateway process reference. */
export function clearGatewayProc(): void {
  state.proc = null;
}

/** Run a command and capture stdout/stderr into a single buffer. */
export function runCmd(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const { env: extraEnv, ...spawnOpts } = opts;
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      env: mergeEnv(extraEnv),
    });

    let out = "";
    proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));

    proc.on("error", (err: Error) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const exitCode = code ?? (signal ? 1 : 0);
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

/** Configure trusted proxies for Railway's internal network. */
async function configureTrustedProxies(): Promise<void> {
  // Railway uses CGNAT range 100.64.0.0/10 for internal routing.
  // Also trust localhost since the wrapper proxies from 127.0.0.1.
  const trustedProxies = ["100.64.0.0/10", "127.0.0.1", "::1", "10.0.0.0/8"];
  const proxiesJson = JSON.stringify(trustedProxies);
  
  console.log(`[gateway] configuring trustedProxies: ${proxiesJson}`);
  console.log(`[gateway] config path: ${configPath()}`);
  
  // Try setting via CLI first
  const r1 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", proxiesJson]));
  console.log(`[gateway] trustedProxies CLI set: exit=${r1.code} output=${r1.output.trim() || '(none)'}`);
  
  // Also enable trust proxy mode if the gateway supports it
  const r2 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.trustProxy", "true"]));
  console.log(`[gateway] trustProxy CLI set: exit=${r2.code} output=${r2.output.trim() || '(none)'}`);
  
  // Fallback: directly modify the config file if CLI failed or as additional insurance
  try {
    const cfgPath = configPath();
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, "utf8");
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(content);
      } catch {
        console.log(`[gateway] config file is not valid JSON, skipping direct write`);
        return;
      }
      
      // Ensure gateway section exists
      if (!config.gateway || typeof config.gateway !== "object") {
        config.gateway = {};
      }
      const gw = config.gateway as Record<string, unknown>;
      
      // Set trustedProxies
      gw.trustedProxies = trustedProxies;
      gw.trustProxy = true;
      
      // Write back
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), { encoding: "utf8" });
      console.log(`[gateway] trustedProxies written directly to config file`);
    }
  } catch (err) {
    console.error(`[gateway] failed to write trustedProxies to config file:`, err);
  }
  
  // Verify the settings were applied
  const verify = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "gateway.trustedProxies"]));
  console.log(`[gateway] trustedProxies verify: ${verify.output.trim()}`);
}

/** Start the gateway process if it is not already running. */
async function startGateway(): Promise<void> {
  if (state.proc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  ensureDirectories();

  // Ensure trustedProxies is configured before starting.
  await configureTrustedProxies();

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
    "--force",
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

/** Ensure the gateway is running, starting it when needed. */
export async function ensureGatewayRunning(): Promise<GatewayResult> {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (state.proc) return { ok: true };
  
  if (!state.starting) {
    state.starting = (async () => {
      try {
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        if (state.proc) {
          await terminateProcess(state.proc);
          state.proc = null;
        }
        throw err;
      }
    })().finally(() => {
      state.starting = null;
    });
  }
  
  await state.starting;
  return { ok: true };
}

/** Stop the gateway if running, then restart it. */
export async function restartGateway(): Promise<GatewayResult> {
  if (state.proc) {
    await terminateProcess(state.proc);
    state.proc = null;
  }
  return ensureGatewayRunning();
}

/** Stop the gateway if running. */
export async function stopGateway(): Promise<void> {
  if (state.proc) {
    await terminateProcess(state.proc);
    state.proc = null;
  }
}

/** Best-effort shutdown used during wrapper process exit. */
export function shutdownGateway(): void {
  try {
    if (state.proc) {
      state.proc.kill("SIGTERM");
    }
  } catch {
    // Ignore shutdown errors on exit.
  }
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
