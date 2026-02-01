import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AuthGroup, OnboardPayload } from "./types.js";

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
 * reliably listen on 8080 unless explicitly overridden.
 *
 * Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
 * Keep CLAWDBOT_PUBLIC_PORT as a backward-compat alias for older templates.
 */
export const PORT: number = Number.parseInt(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT ?? "8080",
  10,
);

/**
 * State/workspace directories.
 * OpenClaw defaults to ~/.openclaw. Keep CLAWDBOT_* as backward-compat aliases.
 */
export const STATE_DIR: string =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

export const WORKSPACE_DIR: string =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

/**
 * Protect /setup with a user-provided password.
 * In dev mode (no RAILWAY_ENVIRONMENT), allow bypass with DEV_MODE=1
 */
export const SETUP_PASSWORD: string | undefined = process.env.SETUP_PASSWORD?.trim();

export const DEV_MODE: boolean = 
  !process.env.RAILWAY_ENVIRONMENT && 
  (process.env.DEV_MODE === "1" || process.env.NODE_ENV === "development");

/**
 * Where the gateway will listen internally (we proxy to it).
 */
export const INTERNAL_GATEWAY_PORT: number = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10
);
export const INTERNAL_GATEWAY_HOST: string = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
export const GATEWAY_TARGET: string = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

/**
 * Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
 */
export const OPENCLAW_ENTRY: string = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
export const OPENCLAW_NODE: string = process.env.OPENCLAW_NODE?.trim() || "bun";

/**
 * UI directory path
 */
export const UI_DIR: string = path.join(process.cwd(), "src", "ui");

// ============================================================================
// Gateway Token Resolution
// ============================================================================

function resolveGatewayToken(): string {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

export const OPENCLAW_GATEWAY_TOKEN: string = resolveGatewayToken();

// Set environment variables for child processes
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
process.env.CLAWDBOT_GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get CLI arguments with the entry point prepended.
 */
export function clawArgs(args: string[]): string[] {
  return [OPENCLAW_ENTRY, ...args];
}

/**
 * Get the path to the OpenClaw config file.
 */
export function configPath(): string {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

/**
 * Check if OpenClaw is configured (config file exists).
 */
export function isConfigured(): boolean {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

/**
 * Ensure state and workspace directories exist.
 */
export function ensureDirectories(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

/**
 * Get environment variables for child processes.
 */
export function getChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
    CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
  };
}

// ============================================================================
// Auth Groups Definition
// ============================================================================

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

// ============================================================================
// Auth Secret Mapping
// ============================================================================

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

// ============================================================================
// Onboarding Arguments Builder
// ============================================================================

/**
 * Build CLI arguments for the onboard command.
 */
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

// ============================================================================
// Allowed Console Commands
// ============================================================================

export const ALLOWED_CONSOLE_COMMANDS = new Set<string>([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",
  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
  "openclaw.pairing.list",
]);
