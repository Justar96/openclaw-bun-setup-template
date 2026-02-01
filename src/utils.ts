import path from "node:path";

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Sleep for the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Secret Redaction
// ============================================================================

const SECRET_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{10,})/g,           // OpenAI keys
  /(gho_[A-Za-z0-9_]{10,})/g,            // GitHub OAuth tokens
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,     // Slack tokens
  /(AA[A-Za-z0-9_-]{10,}:\S{10,})/g,     // Telegram bot tokens
];

/**
 * Redact common secret patterns from text.
 * This is a best-effort redaction; config paths/values may still contain secrets.
 */
export function redactSecrets(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ============================================================================
// Path Safety Utilities
// ============================================================================

/**
 * Check if a path is under a root directory.
 */
export function isUnderDir(p: string, root: string): boolean {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

/**
 * Check if a tar path looks safe (no absolute paths, no traversal).
 */
export function looksSafeTarPath(p: string): boolean {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

// ============================================================================
// Request Body Utilities
// ============================================================================

/**
 * Read the raw body of a request as a Buffer, with a maximum size limit.
 */
export async function readBodyBuffer(
  req: { on: (event: string, handler: (data?: Buffer | Error) => void) => void; destroy: () => void },
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    
    req.on("data", (chunk) => {
      if (!(chunk instanceof Buffer)) return;
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Parse a comma-separated string into an array of trimmed, non-empty strings.
 */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Safe JSON stringify that handles circular references.
 */
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
