import type { ChildProcess } from "node:child_process";

// ============================================================================
// Gateway Types
// ============================================================================

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
}

export interface GatewayState {
  proc: ChildProcess | null;
  starting: Promise<void> | null;
}

// ============================================================================
// Auth Types
// ============================================================================

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

// ============================================================================
// Onboarding Payload Types
// ============================================================================

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

// ============================================================================
// Channel Configuration Types
// ============================================================================

export interface DiscordGuildConfig {
  enabled: boolean;
  requireMention: boolean;
  channels?: Record<string, { enabled: boolean }>;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  groupPolicy: string;
  historyLimit: number;
  streamMode: string;
  commands: {
    native: boolean;
  };
  dm: {
    enabled: boolean;
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

// ============================================================================
// Pairing Types
// ============================================================================

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

// ============================================================================
// API Request Payload Types
// ============================================================================

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

// ============================================================================
// Status Response Types
// ============================================================================

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
