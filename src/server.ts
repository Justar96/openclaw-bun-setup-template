import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import express, { Request, Response, NextFunction, Application } from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Local wrapper types.
import type {
  ChannelResult,
  ConfigRawPayload,
  ConsolePayload,
  DiscordConfig,
  OnboardPayload,
  PairingApprovePayload,
  PairingEntry,
  SlackConfig,
  TelegramConfig,
} from "./types.js";

import { isUnderDir, looksSafeTarPath, parseCommaSeparated, readBodyBuffer, redactSecrets } from "./utils.js";

import {
  ALLOWED_CONSOLE_COMMANDS,
  AUTH_GROUPS,
  buildOnboardArgs,
  clawArgs,
  configPath,
  DEV_MODE,
  ensureDirectories,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_PORT,
  isConfigured,
  OPENCLAW_ENTRY,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_NODE,
  PORT,
  SETUP_PASSWORD,
  STATE_DIR,
  UI_DIR,
  WORKSPACE_DIR,
} from "./config.js";

import {
  deleteConfigFile,
  ensureGatewayRunning,
  readConfigFile,
  restartGateway,
  runCmd,
  shutdownGateway,
  stopGateway,
  writeConfigFile,
} from "./gateway.js";

const MAX_IMPORT_BYTES = 250 * 1024 * 1024;

function getAuthHeader(req: Request): string {
  const header = req.headers.authorization;
  if (Array.isArray(header)) return header[0] ?? "";
  return header ?? "";
}

function decodeBasicPassword(header: string): string | null {
  const [scheme, encoded] = header.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx >= 0 ? decoded.slice(idx + 1) : "";
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | number | undefined, fallback: number, min = 1, max = 1000): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sendUiFile(res: Response, fileName: string, contentType: string): void {
  try {
    const filePath = path.join(UI_DIR, fileName);
    const body = fs.readFileSync(filePath);
    res.type(contentType).send(body);
  } catch (err) {
    console.error(`[ui] failed to read ${fileName}:`, err);
    res.status(500).type("text/plain").send("UI asset unavailable.");
  }
}

// Authentication guard for setup routes.
function requireSetupAuth(req: Request, res: Response, next: NextFunction): void {
  if (DEV_MODE) {
    next();
    return;
  }

  if (!SETUP_PASSWORD) {
    res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
    return;
  }

  const header = getAuthHeader(req);
  const password = decodeBasicPassword(header);
  if (password === null) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    res.status(401).send("Auth required");
    return;
  }
  if (!safeEqual(password, SETUP_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    res.status(401).send("Invalid password");
    return;
  }

  next();
}

const app: Application = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Health check used by Railway.
app.get("/setup/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/setup/ui/styles.css", requireSetupAuth, (_req: Request, res: Response) => {
  sendUiFile(res, "styles.css", "text/css");
});

app.get("/setup/ui/app.js", requireSetupAuth, (_req: Request, res: Response) => {
  sendUiFile(res, "app.js", "application/javascript");
});

// Legacy route preserved for older bookmarks.
app.get("/setup/app.js", requireSetupAuth, (_req: Request, res: Response) => {
  sendUiFile(res, "app.js", "application/javascript");
});

app.get("/setup", requireSetupAuth, (_req: Request, res: Response) => {
  sendUiFile(res, "setup.html", "text/html");
});

app.get("/setup/api/status", requireSetupAuth, async (_req: Request, res: Response) => {
  const [version, channelsHelp] = await Promise.all([
    runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
    runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
  ]);

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.post("/setup/api/run", requireSetupAuth, async (req: Request, res: Response) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    ensureDirectories();

    const payload: OnboardPayload =
      req.body && typeof req.body === "object" ? (req.body as OnboardPayload) : {};
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      // Persist gateway settings for the CLI.
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

      const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name: string): boolean => helpText.includes(name);

      // Configure Telegram if requested.
      if (payload.telegramToken?.trim()) {
        extra += await configureTelegram(payload, supports);
      }

      // Configure Discord if requested.
      if (payload.discordToken?.trim()) {
        extra += await configureDiscord(payload, supports);
      }

      // Configure Slack if requested.
      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureSlack(payload, supports);
      }

      await restartGateway();
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

// Helpers for channel configuration during onboarding.

async function configureTelegram(
  payload: OnboardPayload,
  supports: (name: string) => boolean
): Promise<string> {
  if (!supports("telegram")) {
    return "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
  }

  const token = payload.telegramToken!.trim();
  const cfgObj: TelegramConfig = {
    enabled: true,
    dmPolicy: "pairing",
    botToken: token,
    groupPolicy: "allowlist",
    streamMode: "partial",
  };

  const set = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)])
  );
  const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

  return `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
    `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
}

async function configureDiscord(
  payload: OnboardPayload,
  supports: (name: string) => boolean
): Promise<string> {
  if (!supports("discord")) {
    return "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
  }

  const token = payload.discordToken!.trim();
  const dmPolicy = payload.discordDmPolicy?.trim() || "pairing";
  const historyLimit = parsePositiveInt(payload.discordHistoryLimit, 20, 1, 1000);
  const commandsNative = parseBooleanFlag(payload.discordNativeCommands, true);
  const dmEnabled = parseBooleanFlag(payload.discordDmEnabled, true);

  const cfgObj: DiscordConfig = {
    enabled: true,
    token,
    groupPolicy: payload.discordGroupPolicy?.trim() || "allowlist",
    historyLimit,
    streamMode: payload.discordStreamMode?.trim() || "partial",
    commands: { native: commandsNative },
    dm: {
      enabled: dmEnabled,
      policy: dmPolicy,
    },
  };

  // Add an optional guild allowlist.
  if (payload.discordGuildId?.trim()) {
    const guildId = payload.discordGuildId.trim();
    cfgObj.guilds = {
      [guildId]: {
        enabled: true,
        requireMention: parseBooleanFlag(payload.discordRequireMention, false),
      },
    };
    if (payload.discordChannelId?.trim()) {
      cfgObj.guilds[guildId].channels = {
        [payload.discordChannelId.trim()]: { enabled: true },
      };
    }
  }

  // Add DM allowlist entries when policy requires them.
  if (dmPolicy === "allowlist" && payload.discordAllowFrom?.trim()) {
    cfgObj.dm.allowFrom = parseCommaSeparated(payload.discordAllowFrom);
  }

  const set = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)])
  );
  const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  return `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
    `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
}

async function configureSlack(
  payload: OnboardPayload,
  supports: (name: string) => boolean
): Promise<string> {
  if (!supports("slack")) {
    return "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
  }

  const cfgObj: SlackConfig = {
    enabled: true,
    botToken: payload.slackBotToken?.trim() || undefined,
    appToken: payload.slackAppToken?.trim() || undefined,
  };

  const set = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)])
  );
  const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));

  return `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
    `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
}

// Diagnostics for setup troubleshooting.

app.get("/setup/api/debug", requireSetupAuth, async (_req: Request, res: Response) => {
  const [v, help] = await Promise.all([
    runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
    runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
  ]);

  const isBun = typeof Bun !== "undefined";
  const runtime = isBun ? "bun" : "node";
  const version = isBun ? Bun.version : process.version;

  res.json({
    wrapper: {
      runtime,
      version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(
        process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()
      ),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// Restricted console commands for the setup UI.

app.post("/setup/api/console/run", requireSetupAuth, async (req: Request, res: Response) => {
  const payload: ConsolePayload =
    req.body && typeof req.body === "object" ? (req.body as ConsolePayload) : {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    // Gateway lifecycle commands.
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      await stopGateway();
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({
        ok: Boolean(r.ok),
        output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n`,
      });
    }

    // OpenClaw CLI commands.
    const cmdMap: Record<string, string[]> = {
      "openclaw.version": ["--version"],
      "openclaw.status": ["status"],
      "openclaw.health": ["health"],
      "openclaw.doctor": ["doctor"],
    };

    if (cmdMap[cmd]) {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(cmdMap[cmd]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    if (cmd === "openclaw.pairing.list") {
      const channel = arg || "discord";
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", channel]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Raw config read/write endpoints.

app.get("/setup/api/config/raw", requireSetupAuth, async (_req: Request, res: Response) => {
  try {
    const p = configPath();
    const { exists, content } = readConfigFile(p);
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: ConfigRawPayload =
      req.body && typeof req.body === "object" ? (req.body as ConfigRawPayload) : {};
    const content = String(payload.content || "");

    if (content.length > 500_000) {
      res.status(413).json({ ok: false, error: "Config too large" });
      return;
    }

    const p = configPath();
    writeConfigFile(p, content);

    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Pairing discovery and approval endpoints.

app.get("/setup/api/pairing/list", requireSetupAuth, async (req: Request, res: Response) => {
  const channel = typeof req.query.channel === "string" ? req.query.channel.trim() : "";
  const channels = channel ? [channel] : ["discord", "telegram", "slack", "whatsapp", "signal", "imessage"];

  const results: Record<string, ChannelResult> = {};

  for (const ch of channels) {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", ch]));
    const output = r.output || "";
    const pending: PairingEntry[] = [];

    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        pending.push(...parsed);
      }
    } catch {
      const lines = output.split("\n");
      for (const line of lines) {
        const codeMatch = line.match(/([A-Z0-9]{8})/);
        const userMatch =
          line.match(/user[:\s]+(\S+)/i) ||
          line.match(/from[:\s]+(\S+)/i) ||
          line.match(/sender[:\s]+(\S+)/i);
        if (codeMatch) {
          pending.push({
            code: codeMatch[1],
            user: userMatch ? userMatch[1] : "unknown",
            raw: line.trim(),
          });
        }
      }
    }

    results[ch] = { ok: r.code === 0, pending, raw: output };
  }

  res.json({ ok: true, channels: results });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req: Request, res: Response) => {
  const payload: PairingApprovePayload =
    req.body && typeof req.body === "object" ? (req.body as PairingApprovePayload) : {};
  const channel = String(payload.channel ?? "").trim();
  const code = String(payload.code ?? "").trim();

  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }

  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Setup reset endpoint.

app.post("/setup/api/reset", requireSetupAuth, async (_req: Request, res: Response) => {
  try {
    deleteConfigFile(configPath());
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

// Backup export/import endpoints.

app.get("/setup/export", requireSetupAuth, async (_req: Request, res: Response) => {
  ensureDirectories();

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`
  );

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const dataRoot = "/data";
  const underData = (p: string): boolean => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, "")).filter(Boolean);

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  paths = Array.from(new Set(paths));
  const stream = tar.c({ gzip: true, portable: true, noMtime: true, cwd, onwarn: () => {} }, paths);

  stream.on("error", (err: unknown) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

app.post("/setup/import", requireSetupAuth, async (req: Request, res: Response): Promise<void> => {
  let tmpPath: string | null = null;
  try {
    const dataRoot = "/data";

    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
      return;
    }

    await stopGateway();

    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength && contentLength > MAX_IMPORT_BYTES) {
      res.status(413).type("text/plain").send("Payload too large\n");
      return;
    }

    const buf = await readBodyBuffer(req, MAX_IMPORT_BYTES);
    if (!buf.length) {
      res.status(400).type("text/plain").send("Empty body\n");
      return;
    }

    tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p: string, entry) => {
        if (!looksSafeTarPath(p)) return false;
        const type = entry?.type;
        return type === "File" || type === "Directory";
      },
    });

    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("payload too large") ? 413 : 500;
    res.status(status).type("text/plain").send(message);
  } finally {
    if (tmpPath) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore temp cleanup errors.
      }
    }
  }
});

// Reverse proxy to the internal gateway.

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err: Error, _req: IncomingMessage, _res: ServerResponse | Socket) => {
  console.error("[proxy]", err);
});

app.use(async (req: Request, res: Response) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Wrapper startup logging and binding.

const server = app.listen(PORT, "0.0.0.0", () => {
  const isBun = typeof Bun !== "undefined";
  const runtime = isBun ? `Bun ${Bun.version}` : `Node ${process.version}`;

  console.log(`[wrapper] running on ${runtime}`);
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
});

server.on("error", (err: Error) => {
  console.error("[wrapper] server error:", err);
});

server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }

  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// Shutdown hooks for Railway and local signals.

process.on("SIGTERM", () => {
  shutdownGateway();
  process.exit(0);
});

process.on("SIGINT", () => {
  shutdownGateway();
  process.exit(0);
});

// Bun global typing for TS when running under Node.

declare global {
  const Bun: { version: string } | undefined;
}
