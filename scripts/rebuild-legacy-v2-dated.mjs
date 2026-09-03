#!/usr/bin/env node
/**
 * Rebuild the full curated legacy→2.x history with backdated commits.
 * Dates: day N = today - (total - N) calendar days (Europe/Moscow noon).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const queuePath = join(__dirname, "legacy-v2-queue.json");
const worktree = join(root, "..", "orihon-legacy-replay");
const BASE = "632c987"; // Rebuild tip on legacy (pre day-1)
const END = new Date("2026-08-30T12:00:00+03:00");

const dryRun = process.argv.includes("--dry-run");
const noPush = process.argv.includes("--no-push");

function run(cmd, cwd = root, opts = {}) {
  const [bin, ...rest] = cmd;
  const r = spawnSync(bin, rest, {
    cwd,
    encoding: "utf8",
    // never shell — Windows eats `^` in `sha^{commit}`
    shell: false,
    env: { ...process.env, ...opts.env },
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  if (r.status !== 0) {
    throw new Error(
      `${bin} ${rest.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return (r.stdout || "").trim();
}

function setPackageVersion(dir, version) {
  for (const file of ["package.json", "package-lock.json"]) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    let raw = readFileSync(p, "utf8");
    if (file === "package.json") {
      raw = raw.replace(/("version":\s*")([^"]+)(")/, `$1${version}$3`);
    } else {
      // top-level lock version only (first "version" in file)
      raw = raw.replace(/("version":\s*")([^"]+)(")/, `$1${version}$3`);
      raw = raw.replace(
        /("name":\s*"orihon",\s*"version":\s*")([^"]+)(")/,
        `$1${version}$3`,
      );
    }
    writeFileSync(p, raw.endsWith("\n") ? raw : raw + "\n");
  }
}

function dateForDay(day, total) {
  const d = new Date(END);
  d.setDate(d.getDate() - (total - day));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dayNum = String(d.getDate()).padStart(2, "0");
  // stagger hour slightly so same-day siblings (if any) sort cleanly
  const hour = 10 + ((day - 1) % 8);
  return `${y}-${m}-${dayNum}T${String(hour).padStart(2, "0")}:00:00+03:00`;
}

const queue = JSON.parse(readFileSync(queuePath, "utf8"));
const steps = queue.steps;
const total = steps.length;

console.log(`Rewriting ${total} steps from ${BASE}, ending ${END.toISOString()}`);
for (const s of steps) {
  console.log(
    `  day ${String(s.day).padStart(2)}  ${dateForDay(s.day, total).slice(0, 10)}  ${s.version}  ${s.message}`,
  );
}
if (dryRun) process.exit(0);

run(["git", "fetch", "legacy"]);
run(["git", "fetch", "origin"]);
run(["git", "rev-parse", "--verify", `${BASE}^{commit}`]);

if (existsSync(worktree)) {
  try {
    run(["git", "worktree", "remove", "--force", worktree]);
  } catch {
    // fall through — may already be gone
  }
}
run(["git", "worktree", "add", "-B", "legacy-replay", worktree, BASE]);

for (const step of steps) {
  const tip = run(["git", "rev-parse", "--verify", `${step.tip_sha}^{commit}`]);
  const shortTip = tip.slice(0, 7);
  const when = dateForDay(step.day, total);
  console.log(`\n→ day ${step.day} ${step.version} @ ${when} (tree ${shortTip})`);

  run(
    ["git", "restore", `--source=${shortTip}`, "--worktree", "--staged", ":"],
    worktree,
  );
  setPackageVersion(worktree, step.version);
  const ver = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")).version;
  if (ver !== step.version) {
    throw new Error(`version mismatch day ${step.day}: got ${ver}`);
  }
  run(["git", "add", "-A"], worktree);
  run(["git", "commit", "-m", step.message], worktree, {
    env: {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

const tipSha = run(["git", "rev-parse", "--short", "HEAD"], worktree);
console.log(`\nTip: ${tipSha}`);
run(
  ["git", "log", "--format=%h %ad %s", "--date=short", "-21"],
  worktree,
  { inherit: true },
);

if (!noPush) {
  console.log("\nForce-pushing to legacy/master…");
  run(["git", "push", "--force", "legacy", "HEAD:master"], worktree, {
    inherit: true,
  });
}

queue.completed = steps.map((s) => s.day);
queue.last = {
  day: steps[steps.length - 1].day,
  version: steps[steps.length - 1].version,
  sha: tipSha,
  tip_sha: steps[steps.length - 1].tip_sha,
  at: new Date().toISOString(),
  dating: "backdated from 2026-08-30 backwards one day per step",
};
writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
console.log("Queue updated. Done.");
