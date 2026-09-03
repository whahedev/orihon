#!/usr/bin/env node
/**
 * Apply the next (or a specific) step from legacy-v2-queue.json onto orihon-legacy.
 *
 * Usage (from repo root, with remotes `legacy` and `origin`):
 *   node scripts/apply-legacy-v2-step.mjs          # next pending
 *   node scripts/apply-legacy-v2-step.mjs --day 3  # specific day
 *   node scripts/apply-legacy-v2-step.mjs --dry-run
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const queuePath = join(__dirname, "legacy-v2-queue.json");
const worktree = join(root, "..", "orihon-legacy-replay");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const dayIdx = process.argv.indexOf("--day");
const dayArg = dayIdx >= 0 ? Number(process.argv[dayIdx + 1]) : null;

function run(cmd, cwd = root, inherit = false) {
  const [bin, ...rest] = cmd;
  const r = spawnSync(bin, rest, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`${bin} ${rest.join(" ")} failed (${r.status}): ${err}`);
  }
  return (r.stdout || "").trim();
}

function setPackageVersion(dir, version) {
  for (const file of ["package.json", "package-lock.json"]) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const next = raw.replace(
      /("name":\s*"orihon"[\s\S]*?"version":\s*")([^"]+)(")/,
      `$1${version}$3`,
    );
    // package-lock also has a top-level version next to name
    const next2 =
      file === "package-lock.json"
        ? next.replace(/("version":\s*")([^"]+)(")/, `$1${version}$3`)
        : next;
    // package.json: only the root version field (first occurrence after name is fine)
    const final =
      file === "package.json"
        ? raw.replace(/("version":\s*")([^"]+)(")/, `$1${version}$3`)
        : next2.replace(/^(\s*"version":\s*")([^"]+)(")/m, `$1${version}$3`);
    writeFileSync(p, final.endsWith("\n") ? final : final + "\n");
  }
}

const queue = JSON.parse(readFileSync(queuePath, "utf8"));
const completed = new Set(queue.completed || []);
const step =
  dayArg != null
    ? queue.steps.find((s) => s.day === dayArg)
    : queue.steps.find((s) => !completed.has(s.day));

if (!step) {
  console.log("No pending steps.");
  process.exit(0);
}

if (completed.has(step.day) && dayArg == null) {
  console.log(`Day ${step.day} already completed.`);
  process.exit(0);
}

console.log(`Day ${step.day} → ${step.version}: ${step.message}`);
console.log(`tip_sha=${step.tip_sha}`);

if (dryRun) process.exit(0);

run(["git", "fetch", "legacy"]);
run(["git", "fetch", "origin"]);

const tip = run(["git", "rev-parse", "--verify", `${step.tip_sha}^{commit}`]);
const shortTip = tip.slice(0, 7);

if (!existsSync(join(worktree, ".git")) && !existsSync(worktree)) {
  run([
    "git",
    "worktree",
    "add",
    "-B",
    "legacy-replay",
    worktree,
    "legacy/master",
  ]);
} else {
  run(["git", "fetch", "legacy"], worktree);
  run(["git", "checkout", "-B", "legacy-replay", "legacy/master"], worktree);
}

run(["git", "restore", `--source=${shortTip}`, "--worktree", "--staged", ":"], worktree);
setPackageVersion(worktree, step.version);

const verLine = run(
  ["node", "-e", "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)"],
  worktree,
);
if (verLine !== step.version) {
  throw new Error(`version mismatch: expected ${step.version}, got ${verLine}`);
}

run(["git", "add", "-A"], worktree);
const staged = run(["git", "diff", "--cached", "--name-only"], worktree);
if (!staged) {
  throw new Error("Nothing to commit — tree already matches?");
}

run(["git", "commit", "-m", step.message], worktree, true);
run(["git", "push", "legacy", "HEAD:master"], worktree, true);

const sha = run(["git", "rev-parse", "--short", "HEAD"], worktree);
queue.completed = [...new Set([...(queue.completed || []), step.day])].sort(
  (a, b) => a - b,
);
queue.last = {
  day: step.day,
  version: step.version,
  sha,
  tip_sha: shortTip,
  at: new Date().toISOString(),
};
writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
console.log(`Done: ${sha} (${step.version})`);
