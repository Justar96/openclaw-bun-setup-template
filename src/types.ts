import type { ChildProcess } from "node:child_process";

// Gateway process and lifecycle types.

export interface GatewayResult {
  ok: boolean;
  reason?: string;
}

export interface CommandResult {
  code: number;
  output: string;
}

export interface WaitForGatewayOptions {
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface GatewayState {
  proc: ChildProcess | null;
  starting: Promise<void> | null;
  crashHistory: number[];        // Timestamps of recent crashes
  consecutiveFails: number;      // Count of consecutive startup failures
  circuitOpen: boolean;          // Circuit breaker state
  circuitOpenedAt: number | null; // When circuit was opened
  lastHealthCheck: number | null; // Last successful health check timestamp
  healthCheckTimer: ReturnType<typeof setInterval> | null;
}

// Auth provider configuration used by the setup UI.

export interface AuthOption {
  value: string;
  label: string;
}

export interface AuthGroup {
  value: string;
  label: string;
  hint: string;
  options: AuthOption[];
}

// Payload captured during onboarding.

export interface OnboardPayload {
  flow?: string;
  authChoice?: string;
  authSecret?: string;
  telegramToken?: string;
  discordToken?: string;
  discordDmPolicy?: string;
  discordGroupPolicy?: string;
  discordHistoryLimit?: string | number;
  discordStreamMode?: string;
  discordNativeCommands?: string;
  discordDmEnabled?: string;
  discordGuildId?: string;
  discordChannelId?: string;
  discordRequireMention?: string;
  discordAllowFrom?: string;
  slackBotToken?: string;
  slackAppToken?: string;
}

// Channel configuration shapes persisted in the OpenClaw config.

export interface DiscordGuildConfig {
  enabled: boolean;
  requireMention: boolean;
  channels?: Record<string, { enabled: boolean }>;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  groupPolicy: string;
  historyLimit?: number;
  streamMode?: string;
  commands?: {
    native: boolean;
  };
  dm: {
    enabled?: boolean;
    policy: string;
    allowFrom?: string[];
  };
  guilds?: Record<string, DiscordGuildConfig>;
}

export interface TelegramConfig {
  enabled: boolean;
  dmPolicy: string;
  botToken: string;
  groupPolicy: string;
  streamMode: string;
}

export interface SlackConfig {
  enabled: boolean;
  botToken?: string;
  appToken?: string;
}

// Pairing status output.

export interface PairingEntry {
  code: string;
  user: string;
  raw: string;
}

export interface ChannelResult {
  ok: boolean;
  pending: PairingEntry[];
  raw: string;
}

// API payloads sent from the setup UI.

export interface ConsolePayload {
  cmd?: string;
  arg?: string;
}

export interface ConfigRawPayload {
  content?: string;
}

export interface PairingApprovePayload {
  channel?: string;
  code?: string;
}

// Wrapper status and debug responses.

export interface StatusResponse {
  configured: boolean;
  gatewayTarget: string;
  openclawVersion: string;
  channelsAddHelp: string;
  authGroups: AuthGroup[];
}

export interface DebugResponse {
  wrapper: {
    runtime: string;
    version: string;
    port: number;
    stateDir: string;
    workspaceDir: string;
    configPath: string;
    gatewayTokenFromEnv: boolean;
    gatewayTokenPersisted: boolean;
    railwayCommit: string | null;
  };
  openclaw: {
    entry: string;
    node: string;
    version: string;
    channelsAddHelpIncludesTelegram: boolean;
  };
}
