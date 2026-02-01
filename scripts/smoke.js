import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Quick sanity check to ensure the CLI entry is runnable.
const entry =
  process.env.OPENCLAW_ENTRY?.trim() || path.join(process.cwd(), "openclaw", "dist", "entry.js");
const runtime = process.env.OPENCLAW_NODE?.trim() || "bun";

if (!fs.existsSync(entry)) {
  console.error(`OpenClaw entry not found: ${entry}`);
  process.exit(1);
}

const r = spawnSync(runtime, [entry, "--version"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error(r.stdout || r.stderr);
  process.exit(r.status ?? 1);
}
console.log("openclaw ok:", r.stdout.trim());
