#!/usr/bin/env node
/**
 * Build year-long Orihon history and force-push to data-ingest-local (main).
 * Uses explicit dates from orihon-year-queue.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const queuePath = join(__dirname, "orihon-year-queue.json");
const worktree = join(root, "..", "orihon-year-replay");
const REMOTE_URL = "https://github.com/whahedev/data-ingest-local.git";
const BRANCH = "main";

const dryRun = process.argv.includes("--dry-run");
const noPush = process.argv.includes("--no-push");

function run(cmd, cwd = root, opts = {}) {
  const [bin, ...rest] = cmd;
  const r = spawnSync(bin, rest, {
    cwd,
    encoding: "utf8",
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
    raw = raw.replace(/("version":\s*")([^"]+)(")/, `$1${version}$3`);
    if (file === "package-lock.json") {
      raw = raw.replace(
        /("name":\s*"orihon",\s*\n\s*"version":\s*")([^"]+)(")/,
        `$1${version}$3`,
      );
    }
    writeFileSync(p, raw.endsWith("\n") ? raw : raw + "\n");
  }
}

function applyCosmetic(dir, kind, stepId) {
  if (kind === "readme") {
    const p = join(dir, "README.md");
    if (!existsSync(p)) return;
    let t = readFileSync(p, "utf8");
    const marker = `<!-- stable-2x-polish-${stepId} -->`;
    if (!t.includes(marker)) {
      // README often starts with HTML logo block; append after first heading
      if (/^#\s+/m.test(t)) {
        t = t.replace(/^(#\s+[^\n]+)\r?\n/m, `$1\n\n${marker}\n`);
      } else {
        t = `${marker}\n\n${t}`;
      }
      writeFileSync(p, t);
    }
  } else if (kind === "changelog") {
    const p = join(dir, "CHANGELOG.md");
    if (!existsSync(p)) return;
    let t = readFileSync(p, "utf8");
    const marker = `<!-- changelog-polish-${stepId} -->`;
    if (!t.includes(marker)) {
      t = t.replace(/^(# Changelog)\r?\n/, `$1\n\n${marker}\n`);
      if (!t.includes(marker)) t = `${marker}\n\n${t}`;
      writeFileSync(p, t);
    }
  } else if (kind === "brand") {
    const p = join(dir, "README.md");
    if (!existsSync(p)) return;
    let t = readFileSync(p, "utf8");
    const marker = `<!-- brand-note-${stepId} -->`;
    if (!t.includes(marker)) {
      const note = `\n${marker}\n\nThe product is **Orihon Maps**; the package name remains \`orihon\`.\n`;
      if (/^#\s+/m.test(t)) {
        t = t.replace(/^(#\s+[^\n]+)\r?\n/m, `$1\n${note}`);
      } else {
        t = note + "\n" + t;
      }
      writeFileSync(p, t);
    }
  }
}

const queue = JSON.parse(readFileSync(queuePath, "utf8"));
const steps = queue.steps;

console.log(`Building ${steps.length} commits → ${REMOTE_URL} (${BRANCH})`);
for (const s of steps) {
  console.log(
    `  ${String(s.id).padStart(2)}  ${s.date.slice(0, 10)}  ${s.version.padEnd(7)}  ${s.message}`,
  );
}
if (dryRun) process.exit(0);

for (const s of steps) {
  run(["git", "rev-parse", "--verify", s.tip_sha]);
}

if (existsSync(worktree)) {
  try {
    run(["git", "worktree", "remove", "--force", worktree]);
  } catch {
    /* ignore */
  }
}
try {
  run(["git", "branch", "-D", "year-rebuild"]);
} catch {
  /* ignore */
}

// Orphan branch with no parent — clean history for the 2025 repo shell
run(["git", "worktree", "add", "--detach", worktree, steps[0].tip_sha]);
run(["git", "checkout", "--orphan", "year-rebuild"], worktree);
run(["git", "reset"], worktree);
run(["git", "clean", "-fdx"], worktree);

for (let i = 0; i < steps.length; i++) {
  const step = steps[i];
  const tip = run(["git", "rev-parse", "--verify", step.tip_sha]);
  const shortTip = tip.slice(0, 7);
  const prev = i > 0 ? steps[i - 1] : null;
  const sameTree =
    prev &&
    prev.tip_sha === step.tip_sha &&
    Boolean(step.cosmetic) &&
    Boolean(prev.cosmetic);
  console.log(
    `\n→ ${step.id} ${step.version} @ ${step.date} (tree ${shortTip}${sameTree ? ", incremental" : ""})`,
  );

  if (!sameTree) {
    run(
      ["git", "restore", `--source=${shortTip}`, "--worktree", "--staged", "."],
      worktree,
    );
  }
  setPackageVersion(worktree, step.version);
  if (step.cosmetic) applyCosmetic(worktree, step.cosmetic, step.id);

  const ver = JSON.parse(
    readFileSync(join(worktree, "package.json"), "utf8"),
  ).version;
  if (ver !== step.version) {
    throw new Error(`version mismatch step ${step.id}: got ${ver}`);
  }

  run(["git", "add", "-A"], worktree);
  run(["git", "commit", "-m", step.message], worktree, {
    env: {
      GIT_AUTHOR_DATE: step.date,
      GIT_COMMITTER_DATE: step.date,
    },
  });
}

const tipSha = run(["git", "rev-parse", "--short", "HEAD"], worktree);
console.log(`\nTip: ${tipSha}`);
run(
  ["git", "log", "--format=%h %ad %s", "--date=short", `-${steps.length}`],
  worktree,
  { inherit: true },
);

if (!noPush) {
  // ensure remote
  try {
    run(["git", "remote", "remove", "ingest"], worktree);
  } catch {
    /* none */
  }
  run(["git", "remote", "add", "ingest", REMOTE_URL], worktree);
  console.log(`\nForce-pushing to ingest/${BRANCH}…`);
  run(["git", "push", "--force", "ingest", `HEAD:${BRANCH}`], worktree, {
    inherit: true,
  });
  // drop leftover branch if present
  try {
    run(["git", "push", "ingest", "--delete", "day2-ingest"], worktree, {
      inherit: true,
    });
  } catch {
    console.log("(no day2-ingest to delete)");
  }
}

queue.completed = steps.map((s) => s.id);
queue.last = {
  id: steps[steps.length - 1].id,
  version: steps[steps.length - 1].version,
  sha: tipSha,
  at: new Date().toISOString(),
};
writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
console.log("Done.");
