import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AuthGroup, OnboardPayload } from "./types.js";

const DEFAULT_PUBLIC_PORT = 8080;
const DEFAULT_INTERNAL_GATEWAY_PORT = 18789;
const LEGACY_OPENCLAW_ENTRY = "/openclaw/dist/entry.js";
const LOCAL_OPENCLAW_ENTRY = path.join(process.cwd(), "openclaw", "dist", "entry.js");

function resolvePort(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function resolveEntryPath(): string {
  const envEntry = process.env.OPENCLAW_ENTRY?.trim();
  if (envEntry) return envEntry;
  return fs.existsSync(LOCAL_OPENCLAW_ENTRY) ? LOCAL_OPENCLAW_ENTRY : LEGACY_OPENCLAW_ENTRY;
}

/** Prefer explicit public port overrides, otherwise fall back to Railway PORT or 8080. */
export const PORT: number = resolvePort(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT,
  DEFAULT_PUBLIC_PORT,
);

/** State/workspace directories with backward-compatible CLAWDBOT aliases. */
export const STATE_DIR: string =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

export const WORKSPACE_DIR: string =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

/** Password gate for /setup; DEV_MODE bypasses this outside Railway. */
export const SETUP_PASSWORD: string | undefined = process.env.SETUP_PASSWORD?.trim();

const inRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
const devOverride = process.env.DEV_MODE === "1";
const nodeDev = process.env.NODE_ENV === "development";
export const DEV_MODE: boolean = !inRailway && (devOverride || nodeDev);

/** Enable proxy request metrics logging. */
export const PROXY_DEBUG: boolean =
  process.env.OPENCLAW_PROXY_DEBUG === "1" || process.env.PROXY_DEBUG === "1";

/** Internal gateway bind target used by the proxy. */
export const INTERNAL_GATEWAY_PORT: number = resolvePort(
  process.env.INTERNAL_GATEWAY_PORT,
  DEFAULT_INTERNAL_GATEWAY_PORT,
);
export const INTERNAL_GATEWAY_HOST: string = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
export const GATEWAY_TARGET: string = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

/** Resolve the OpenClaw CLI entry path, preferring a local build and falling back to legacy paths. */
export const OPENCLAW_ENTRY: string = resolveEntryPath();
export const OPENCLAW_NODE: string = process.env.OPENCLAW_NODE?.trim() || "bun";

/** UI assets live alongside the wrapper source. */
export const UI_DIR: string = path.join(process.cwd(), "src", "ui");

// Resolve the gateway token from env, disk, or a new random value.
function resolveGatewayToken(): string {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Skip unreadable token files and generate a new one.
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Token persistence is best-effort; we can still return the generated value.
  }
  return generated;
}

export const OPENCLAW_GATEWAY_TOKEN: string = resolveGatewayToken();

// Keep child processes aligned with the resolved gateway token.
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
process.env.CLAWDBOT_GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;

/** Prefix CLI arguments with the OpenClaw entrypoint. */
export function clawArgs(args: string[]): string[] {
  return [OPENCLAW_ENTRY, ...args];
}

/** Resolve the OpenClaw config file path. */
export function configPath(): string {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

/** Return true when the config file exists on disk. */
export function isConfigured(): boolean {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

/** Ensure state and workspace directories exist on disk. */
export function ensureDirectories(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

/** Build environment variables for child processes. */
export function getChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
    CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
  };
}

// Auth providers shown in the setup UI.
export const AUTH_GROUPS: AuthGroup[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude Code CLI + API key",
    options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" },
    ],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + OAuth",
    options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    options: [{ value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }],
  },
  {
    value: "moonshot",
    label: "Moonshot AI",
    hint: "Kimi K2 + Kimi Code",
    options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" },
    ],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key",
    options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1 (recommended)",
    options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
    ],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" },
    ],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    options: [{ value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }],
  },
];

// CLI flags for auth secrets keyed by the setup option value.
const AUTH_SECRET_MAP: Record<string, string> = {
  "openai-api-key": "--openai-api-key",
  "apiKey": "--anthropic-api-key",
  "openrouter-api-key": "--openrouter-api-key",
  "ai-gateway-api-key": "--ai-gateway-api-key",
  "moonshot-api-key": "--moonshot-api-key",
  "kimi-code-api-key": "--kimi-code-api-key",
  "gemini-api-key": "--gemini-api-key",
  "zai-api-key": "--zai-api-key",
  "minimax-api": "--minimax-api-key",
  "minimax-api-lightning": "--minimax-api-key",
  "synthetic-api-key": "--synthetic-api-key",
  "opencode-zen": "--opencode-zen-api-key",
};

/** Build CLI arguments for the OpenClaw onboarding command. */
export function buildOnboardArgs(payload: OnboardPayload): string[] {
  const args: string[] = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const flag = AUTH_SECRET_MAP[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

export const ALLOWED_CONSOLE_COMMANDS = new Set<string>([
  // Wrapper lifecycle actions.
  "gateway.restart",
  "gateway.stop",
  "gateway.start",
  "gateway.health",
  "gateway.reset-breaker",
  // OpenClaw CLI helpers.
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
  "openclaw.pairing.list",
]);
