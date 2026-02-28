import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";

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

import { isUnderDir, looksSafeTarPath, parseCommaSeparated, redactSecrets } from "./utils.js";

import {
  ALLOWED_CONSOLE_COMMANDS,
  AUTH_GROUPS,
  buildOnboardArgs,
  clawArgs,
  configPath,
  DEV_MODE,
  ensureDirectories,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_HOST,
  INTERNAL_GATEWAY_PORT,
  isConfigured,
  OPENCLAW_ENTRY,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_NODE,
  PORT,
  PROXY_DEBUG,
  SETUP_PASSWORD,
  STATE_DIR,
  UI_DIR,
  WORKSPACE_DIR,
} from "./config.js";

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

const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024; // 1MB

// Content type mappings for static files.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// --- Authentication helpers ---

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

function checkSetupAuth(req: Request): Response | null {
  if (DEV_MODE) return null;

  if (!SETUP_PASSWORD) {
    return new Response(
      "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  const header = req.headers.get("authorization") || "";
  const password = decodeBasicPassword(header);
  if (password === null) {
    return new Response("Auth required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="OpenClaw Setup"',
        "Content-Type": "text/plain",
      },
    });
  }
  if (!safeEqual(password, SETUP_PASSWORD)) {
    return new Response("Invalid password", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="OpenClaw Setup"',
        "Content-Type": "text/plain",
      },
    });
  }

  return null;
}

// --- Response helpers ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function serveFile(fileName: string): Response {
  try {
    const filePath = path.join(UI_DIR, fileName);
    const body = fs.readFileSync(filePath);
    const ext = path.extname(fileName);
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    return new Response(body, {
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    console.error(`[ui] failed to read ${fileName}:`, err);
    return text("UI asset unavailable.", 500);
  }
}

// --- JSON body parser ---

async function parseJsonBody<T>(req: Request): Promise<T> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_JSON_BYTES) {
    throw new Error("Request body too large");
  }
  
  const body = await req.text();
  if (body.length > MAX_JSON_BYTES) {
    throw new Error("Request body too large");
  }
  
  return body ? JSON.parse(body) as T : ({} as T);
}

// --- Channel configuration helpers ---

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
  const cfgObj: DiscordConfig = {
    enabled: true,
    token,
    groupPolicy: "allowlist",
    dm: {
      policy: "pairing",
    },
  };

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

// --- Route handlers ---

async function handleHealthz(): Promise<Response> {
  return json({ ok: true });
}

async function handleSetupPage(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;
  return serveFile("setup.html");
}

async function handleSetupCss(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;
  return serveFile("styles.css");
}

async function handleSetupJs(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;
  return serveFile("app.js");
}

async function handleApiStatus(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  const [version, channelsHelp] = await Promise.all([
    runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
    runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
  ]);

  return json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
}

async function handleApiRun(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return json({
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    ensureDirectories();

    const payload = await parseJsonBody<OnboardPayload>(req);
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      await syncGatewayTokens();
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));

      const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name: string): boolean => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        extra += await configureTelegram(payload, supports);
      }

      if (payload.discordToken?.trim()) {
        extra += await configureDiscord(payload, supports);
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureSlack(payload, supports);
      }

      // Activate plugins and fix any config issues.
      const doctor = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      extra += `\n[doctor --fix] exit=${doctor.code}\n${doctor.output || "(no output)"}`;

      await restartGateway();
    }

    return json({ ok, output: `${onboard.output}${extra}` }, ok ? 200 : 500);
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return json({ ok: false, output: `Internal error: ${String(err)}` }, 500);
  }
}

async function handleApiDebug(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  const [v, help] = await Promise.all([
    runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
    runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
  ]);

  return json({
    wrapper: {
      runtime: "bun",
      version: Bun.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(
        process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()
      ),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      gatewayHealth: getGatewayHealth(),
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
}

async function handleApiConsoleRun(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  const payload = await parseJsonBody<ConsolePayload>(req);
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return json({ ok: false, error: "Command not allowed" }, 400);
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return json({ ok: true, output: "Gateway restarted (wrapper-managed). Circuit breaker reset.\n" });
    }
    if (cmd === "gateway.stop") {
      await stopGateway();
      return json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return json({
        ok: Boolean(r.ok),
        output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n`,
      });
    }
    if (cmd === "gateway.health") {
      const health = getGatewayHealth();
      return json({
        ok: true,
        output: JSON.stringify(health, null, 2),
        health,
      });
    }
    if (cmd === "gateway.reset-breaker") {
      resetCircuitBreaker();
      return json({ ok: true, output: "Circuit breaker reset. You can now try starting the gateway.\n" });
    }

    const cmdMap: Record<string, string[]> = {
      "openclaw.version": ["--version"],
      "openclaw.status": ["status"],
      "openclaw.health": ["health"],
      "openclaw.doctor": ["doctor"],
    };

    if (cmdMap[cmd]) {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(cmdMap[cmd]));
      return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
    }

    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
    }

    if (cmd === "openclaw.config.get") {
      if (!arg) return json({ ok: false, error: "Missing config path" }, 400);
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
    }

    if (cmd === "openclaw.pairing.list") {
      const channel = arg || "discord";
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", channel]));
      return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
    }

    return json({ ok: false, error: "Unhandled command" }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleApiConfigRaw(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  try {
    const p = configPath();
    const { exists, content } = readConfigFile(p);
    return json({ ok: true, path: p, exists, content });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleApiConfigRawPost(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  try {
    const payload = await parseJsonBody<ConfigRawPayload>(req);
    const content = String(payload.content || "");

    if (content.length > 500_000) {
      return json({ ok: false, error: "Config too large" }, 413);
    }

    const p = configPath();
    writeConfigFile(p, content);

    if (isConfigured()) {
      await restartGateway();
    }

    return json({ ok: true, path: p });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleApiPairingList(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const channel = url.searchParams.get("channel")?.trim() || "";
  const channels = channel ? [channel] : ["discord", "telegram", "slack", "whatsapp", "signal", "imessage"];

  // Run all channel queries in parallel for faster response
  const channelResults = await Promise.all(
    channels.map(async (ch): Promise<[string, ChannelResult]> => {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", ch]), { timeoutMs: 10_000 });
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

      return [ch, { ok: r.code === 0, pending, raw: output }];
    })
  );

  const results: Record<string, ChannelResult> = Object.fromEntries(channelResults);
  return json({ ok: true, channels: results });
}

async function handleApiPairingApprove(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  const payload = await parseJsonBody<PairingApprovePayload>(req);
  const channel = String(payload.channel ?? "").trim();
  const code = String(payload.code ?? "").trim();

  if (!channel || !code) {
    return json({ ok: false, error: "Missing channel or code" }, 400);
  }

  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return json({ ok: r.code === 0, output: r.output }, r.code === 0 ? 200 : 500);
}

async function handleApiReset(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  try {
    deleteConfigFile(configPath());
    return text("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    return text(String(err), 500);
  }
}

async function handleExport(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  ensureDirectories();

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

  // Create tar stream directly to buffer
  const chunks: Buffer[] = [];
  const stream = tar.c({ gzip: true, portable: true, noMtime: true, cwd, onwarn: () => {} }, paths);

  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve(
        new Response(buffer, {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
          },
        })
      );
    });
    stream.on("error", (err: unknown) => {
      console.error("[export]", err);
      resolve(text(String(err), 500));
    });
  });
}

async function handleImport(req: Request): Promise<Response> {
  const authErr = checkSetupAuth(req);
  if (authErr) return authErr;

  let tmpPath: string | null = null;
  try {
    const dataRoot = "/data";

    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return text(
        "Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n",
        400
      );
    }

    await stopGateway();

    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength && contentLength > MAX_IMPORT_BYTES) {
      return text("Payload too large\n", 413);
    }

    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) {
      return text("Empty body\n", 400);
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
        const type = (entry as { type?: string })?.type;
        return type === "File" || type === "Directory";
      },
    });

    // Validate the config file after extraction — remove it if empty/corrupt
    // to prevent gateway crash loops.
    const cfgPath = configPath();
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, "utf-8").trim();
      if (!content || content.length < 3) {
        console.warn("[import] config file is empty after extraction, removing");
        fs.rmSync(cfgPath, { force: true });
      }
    }

    if (isConfigured()) {
      await restartGateway();
    }

    return text("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("payload too large") ? 413 : 500;
    return text(message, status);
  } finally {
    if (tmpPath) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore temp cleanup errors.
      }
    }
  }
}

// --- Gateway proxy ---

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const WS_STRIP_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-extensions",
  "sec-websocket-version",
  "sec-websocket-accept",
  "content-length",
  "host",
]);

function buildProxyHeaders(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null }
): Headers {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);

  // Remove hop-by-hop headers; proxies must not forward these.
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  const existingForwardedFor = headers.get("x-forwarded-for");
  const remoteIp = server.requestIP(req)?.address;

  if (remoteIp && remoteIp !== "unknown") {
    if (!existingForwardedFor) {
      headers.set("x-forwarded-for", remoteIp);
    } else if (!existingForwardedFor.split(",").map((part) => part.trim()).includes(remoteIp)) {
      headers.set("x-forwarded-for", `${existingForwardedFor}, ${remoteIp}`);
    }
  }

  const realIp = existingForwardedFor?.split(",")[0].trim() || remoteIp;
  if (realIp && realIp !== "unknown") {
    headers.set("x-real-ip", realIp);
  }

  const proto = headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  if (!headers.has("x-forwarded-proto") && proto) {
    headers.set("x-forwarded-proto", proto);
  }

  const host = headers.get("x-forwarded-host") || headers.get("host") || url.host;
  if (!headers.has("x-forwarded-host") && host) {
    headers.set("x-forwarded-host", host);
  }

  if (!headers.has("x-forwarded-port")) {
    const port = url.port || (proto === "https" ? "443" : "80");
    headers.set("x-forwarded-port", port);
  }

  headers.set("x-forwarded-by", "openclaw-wrapper");

  return headers;
}

function buildWsClientOptions(rawHeaders: Record<string, string>): { headers: Record<string, string>; protocols: string[] } {
  const protocols = parseCommaSeparated(rawHeaders["sec-websocket-protocol"]);
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (WS_STRIP_HEADERS.has(lower)) continue;
    if (lower === "sec-websocket-protocol") continue;
    headers[key] = value;
  }

  return { headers, protocols };
}

async function proxyToGateway(req: Request, server: { requestIP: (req: Request) => { address: string } | null }): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `${GATEWAY_TARGET}${url.pathname}${url.search}`;

  const headers = buildProxyHeaders(req, server);

  // Inject gateway token for requests without an auth header so the
  // browser Control UI can connect without pasting the token.
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }

  // Rewrite Origin to match the gateway host so the Control UI
  // origin check passes (browser sends the Railway public domain).
  if (headers.has("origin")) {
    headers.set("origin", GATEWAY_TARGET);
  }

  // Strip proxy headers so the loopback gateway treats connections as
  // local. Without this, the gateway sees X-Forwarded-For from upstream
  // Railway proxies, considers them untrusted, and requires pairing.
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-host");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  if (!hasBody) {
    headers.delete("content-length");
  }

  const start = Date.now();

  try {
    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
    });

    if (PROXY_DEBUG) {
      const durationMs = Date.now() - start;
      console.log(`[proxy] ${req.method} ${url.pathname}${url.search} -> ${proxyRes.status} ${durationMs}ms`);
    }

    // Clone response with all headers
    const responseHeaders = new Headers(proxyRes.headers);
    
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    if (PROXY_DEBUG) {
      const durationMs = Date.now() - start;
      console.log(`[proxy] ${req.method} ${url.pathname}${url.search} -> error ${durationMs}ms`);
    }
    console.error("[proxy]", err);
    return text(`Gateway error: ${String(err)}`, 502);
  }
}

// --- Main router ---

type RouteHandler = (req: Request, server: { requestIP: (req: Request) => { address: string } | null }) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [
  // Health check (no auth)
  { method: "GET", pattern: /^\/setup\/healthz$/, handler: handleHealthz },
  
  // Static UI files
  { method: "GET", pattern: /^\/setup$/, handler: handleSetupPage },
  { method: "GET", pattern: /^\/setup\/ui\/styles\.css$/, handler: handleSetupCss },
  { method: "GET", pattern: /^\/setup\/ui\/app\.js$/, handler: handleSetupJs },
  { method: "GET", pattern: /^\/setup\/app\.js$/, handler: handleSetupJs }, // Legacy
  
  // API endpoints
  { method: "GET", pattern: /^\/setup\/api\/status$/, handler: handleApiStatus },
  { method: "POST", pattern: /^\/setup\/api\/run$/, handler: handleApiRun },
  { method: "GET", pattern: /^\/setup\/api\/debug$/, handler: handleApiDebug },
  { method: "POST", pattern: /^\/setup\/api\/console\/run$/, handler: handleApiConsoleRun },
  { method: "GET", pattern: /^\/setup\/api\/config\/raw$/, handler: handleApiConfigRaw },
  { method: "POST", pattern: /^\/setup\/api\/config\/raw$/, handler: handleApiConfigRawPost },
  { method: "GET", pattern: /^\/setup\/api\/pairing\/list$/, handler: handleApiPairingList },
  { method: "POST", pattern: /^\/setup\/api\/pairing\/approve$/, handler: handleApiPairingApprove },
  { method: "POST", pattern: /^\/setup\/api\/reset$/, handler: handleApiReset },
  
  // Backup/restore
  { method: "GET", pattern: /^\/setup\/export$/, handler: handleExport },
  { method: "POST", pattern: /^\/setup\/import$/, handler: handleImport },
];

// --- WebSocket types and connections ---

interface WsData {
  url: string;
  headers: Record<string, string>;
}

type ServerWs = import("bun").ServerWebSocket<WsData>;

const wsConnections = new Map<ServerWs, WebSocket>();

// --- Bun server ---

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // Handle WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!isConfigured()) {
        return new Response("Not configured", { status: 503 });
      }

      // Require auth for WebSocket connections (protects Control UI).
      const wsAuthErr = checkSetupAuth(req);
      if (wsAuthErr) return wsAuthErr;

      try {
        await ensureGatewayRunning();
      } catch (err) {
        return new Response(`Gateway not ready: ${String(err)}`, { status: 503 });
      }

      // Upgrade to WebSocket
      const proxyHeaders = buildProxyHeaders(req, server);
      const wsData: WsData = {
        url: `ws://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}${pathname}${url.search}`,
        headers: Object.fromEntries(proxyHeaders),
      };
      const success = server.upgrade(req, { data: wsData });

      if (success) {
        return undefined; // Bun handles the upgrade
      }
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Route matching
    for (const route of routes) {
      if (method === route.method && route.pattern.test(pathname)) {
        return route.handler(req, server);
      }
    }

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
      try {
        await ensureGatewayRunning();
      } catch (err) {
        return text(`Gateway not ready: ${String(err)}`, 503);
      }
    }

    return proxyToGateway(req, server);
  },

  websocket: {
    async open(ws: ServerWs) {
      const data = ws.data;
      
      try {
        // Connect to gateway WebSocket
        const { headers, protocols } = buildWsClientOptions(data.headers);

        // Inject gateway token for WebSocket connections without auth.
        if (!headers["authorization"]) {
          headers["authorization"] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
        }

        // Rewrite Origin to match the gateway host for Control UI origin check.
        if (headers["origin"]) {
          headers["origin"] = GATEWAY_TARGET;
        }

        // Strip proxy headers so gateway treats the connection as local.
        delete headers["x-forwarded-for"];
        delete headers["x-forwarded-proto"];
        delete headers["x-forwarded-host"];

        const gatewayWs = new WebSocket(
          data.url,
          protocols.length ? { headers, protocols } : { headers }
        );
        
        gatewayWs.binaryType = "arraybuffer";
        
        gatewayWs.onopen = () => {
          wsConnections.set(ws, gatewayWs);
        };
        
        gatewayWs.onmessage = (event) => {
          try {
            if (typeof event.data === "string") {
              ws.send(event.data);
            } else if (event.data instanceof ArrayBuffer) {
              ws.send(new Uint8Array(event.data));
            }
          } catch {
            // Client disconnected
          }
        };
        
        gatewayWs.onclose = () => {
          wsConnections.delete(ws);
          try {
            ws.close();
          } catch {
            // Already closed
          }
        };
        
        gatewayWs.onerror = (err) => {
          console.error("[ws-proxy] gateway error:", err);
          wsConnections.delete(ws);
          try {
            ws.close();
          } catch {
            // Already closed
          }
        };
      } catch (err) {
        console.error("[ws-proxy] connection error:", err);
        ws.close();
      }
    },

    message(ws: ServerWs, message: string | Buffer) {
      const gatewayWs = wsConnections.get(ws);
      if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
        try {
          if (typeof message === "string") {
            gatewayWs.send(message);
          } else {
            gatewayWs.send(message);
          }
        } catch (err) {
          console.error("[ws-proxy] send error:", err);
        }
      }
    },

    close(ws: ServerWs) {
      const gatewayWs = wsConnections.get(ws);
      if (gatewayWs) {
        wsConnections.delete(ws);
        try {
          gatewayWs.close();
        } catch {
          // Already closed
        }
      }
    },
  },
});

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

// --- Shutdown hooks ---

process.on("SIGTERM", () => {
  shutdownGateway();
  process.exit(0);
});

process.on("SIGINT", () => {
  shutdownGateway();
  process.exit(0);
});

export { server };
