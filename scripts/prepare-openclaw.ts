import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tar from "tar";

const REPO = "https://github.com/openclaw/openclaw";
const ref = process.env.OPENCLAW_GIT_REF?.trim() || "main";
const targetDir = path.join(process.cwd(), "openclaw");
const entryPath = path.join(targetDir, "dist", "entry.js");
const markerPath = path.join(targetDir, ".openclaw-ref");
const skipBuild = process.env.OPENCLAW_SKIP_BUILD === "1" || process.env.OPENCLAW_SKIP_BUILD === "true";
const forceBuild = process.env.OPENCLAW_FORCE_REBUILD === "1" || process.env.OPENCLAW_FORCE_REBUILD === "true";
const envEntry = process.env.OPENCLAW_ENTRY?.trim();

function log(message: string): void {
  console.log(`[openclaw] ${message}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function shouldReuseBuild(): Promise<boolean> {
  if (!await pathExists(entryPath)) return false;
  if (!await pathExists(markerPath)) return false;
  const marker = (await fs.promises.readFile(markerPath, "utf8")).trim();
  return marker === ref;
}

async function downloadTarball(tmpDir: string): Promise<string> {
  const candidates = [
    `${REPO}/archive/refs/heads/${ref}.tar.gz`,
    `${REPO}/archive/refs/tags/${ref}.tar.gz`,
    `${REPO}/archive/${ref}.tar.gz`,
  ];

  for (const url of candidates) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const tarPath = path.join(tmpDir, "openclaw.tar.gz");
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(tarPath, buffer);
    return tarPath;
  }

  throw new Error(`Failed to download OpenClaw source for ref ${ref}`);
}

async function stageSource(): Promise<void> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-src-"));
  try {
    const tarPath = await downloadTarball(tmpDir);
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await fs.promises.mkdir(targetDir, { recursive: true });
    await tar.x({ file: tarPath, cwd: targetDir, strip: 1 });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  if (skipBuild) {
    log("skipping build due to OPENCLAW_SKIP_BUILD");
    return;
  }

  if (envEntry && await pathExists(envEntry)) {
    log(`using OPENCLAW_ENTRY at ${envEntry}`);
    return;
  }

  if (!forceBuild && await shouldReuseBuild()) {
    log(`reusing existing build for ref ${ref}`);
    return;
  }

  log(`fetching OpenClaw ${ref}`);
  await stageSource();

  log("installing OpenClaw dependencies");
  await run("pnpm", ["install"], targetDir);

  log("building OpenClaw");
  await run("pnpm", ["run", "build"], targetDir);

  log("building OpenClaw Control UI");
  await run("pnpm", ["run", "ui:build"], targetDir);

  await fs.promises.writeFile(markerPath, `${ref}\n`, "utf8");
  if (!await pathExists(entryPath)) {
    throw new Error(`OpenClaw entry not found at ${entryPath}`);
  }
}

main().catch((err) => {
  console.error("[openclaw]", err);
  process.exit(1);
});
