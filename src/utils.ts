import path from "node:path";

// Common token formats that should not leak into logs or responses.
const SECRET_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{10,})/g, // OpenAI-style keys.
  /(gho_[A-Za-z0-9_]{10,})/g, // GitHub OAuth tokens.
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g, // Slack tokens.
  /(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, // Telegram bot tokens.
];

// Normalize Node/Bun stream chunks into Buffers.
function coerceBuffer(chunk: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return null;
}

/** Pause for the requested number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort redaction for common secrets in text output. */
export function redactSecrets(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/** Return true when the path is inside the provided root directory. */
export function isUnderDir(p: string, root: string): boolean {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

/** Basic tar entry validation to block absolute paths and traversal. */
export function looksSafeTarPath(p: string): boolean {
  if (!p) return false;
  const normalized = p.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("\\")) return false;
  if (normalized.includes("\0")) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  if (normalized.split("/").includes("..")) return false;
  return true;
}

/** Read a request body into memory with a hard size limit. */
export async function readBodyBuffer(
  req: { on: (event: string, handler: (data?: Buffer | Error) => void) => void; destroy: () => void },
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    req.on("data", (chunk) => {
      const buf = coerceBuffer(chunk);
      if (!buf || settled) return;
      total += buf.length;
      if (total > maxBytes) {
        finish(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => finish());
    req.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/** Split a comma-delimited list into trimmed, non-empty entries. */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** JSON stringify that tolerates circular references. */
export function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}
