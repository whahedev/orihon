#!/usr/bin/env node
// `npm create orihon-app` — scaffold a project that already draws a map.
//
// Deliberately small: copy a template, fill three placeholders, print the three commands that
// finish the job. Everything a first map needs and people forget — the CSS import, a container
// with a real height, an attribution — is in the template rather than in prose someone has to
// follow correctly.
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const templatesRoot = join(here, "templates");

const TEMPLATES = [
  { id: "vanilla", label: "Vanilla — Vite + JavaScript" },
  { id: "react", label: "React — Vite + React 18" }
];

const RESERVED = new Set(["node_modules", "favicon.ico"]);

function parseArgs(argv) {
  const options = { directory: null, template: null, install: null, yes: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--template" || arg === "-t") options.template = argv[++index];
    else if (arg.startsWith("--template=")) options.template = arg.slice("--template=".length);
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--install") options.install = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!arg.startsWith("-") && !options.directory) options.directory = arg;
  }
  return options;
}

function usage() {
  return [
    "Usage: npm create orihon-app [directory] [options]",
    "",
    "Options:",
    "  -t, --template <name>   vanilla | react",
    "  -y, --yes               accept the defaults, ask nothing",
    "      --install           run the package install for me",
    "      --no-install        never run it",
    "  -h, --help              show this",
    "",
    "Examples:",
    "  npm create orihon-app my-map",
    "  npm create orihon-app my-map -- --template react --yes"
  ].join("\n");
}

/** npm package names are stricter than directory names, and a bad one fails at install time. */
function packageNameFrom(directory) {
  const name = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-~][^a-z0-9-._~]*/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return name || "orihon-app";
}

async function isUsable(directory) {
  if (!existsSync(directory)) return true;
  const entries = await readdir(directory);
  return entries.filter((entry) => !RESERVED.has(entry)).length === 0;
}

function packageManager() {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

export async function create(argv = [], { cwd = process.cwd(), interactive = true, log = console.log } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log(usage());
    return { helped: true };
  }

  const rl = interactive && !options.yes && stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    const directoryName = options.directory ?? await ask(rl, "Project directory (orihon-app): ", "orihon-app");
    const target = resolve(cwd, directoryName);

    if (!await isUsable(target)) {
      throw new Error(`${directoryName} already exists and is not empty.`);
    }

    let template = options.template;
    if (!template && rl) {
      log("\nTemplate:");
      TEMPLATES.forEach((item, index) => log(`  ${index + 1}) ${item.label}`));
      const choice = await ask(rl, "Choose (1): ", "1");
      template = TEMPLATES[Number(choice) - 1]?.id ?? choice;
    }
    template ??= "vanilla";
    if (!TEMPLATES.some((item) => item.id === template)) {
      throw new Error(`Unknown template "${template}". Available: ${TEMPLATES.map((item) => item.id).join(", ")}.`);
    }

    await mkdir(target, { recursive: true });
    // `_gitignore` is shipped under a name npm will actually publish; every registry strips a
    // literal .gitignore out of the package tarball.
    await cp(join(templatesRoot, template), target, {
      recursive: true,
      filter: (source) => basename(source) !== "node_modules"
    });
    const gitignore = join(target, "_gitignore");
    if (existsSync(gitignore)) {
      await cp(gitignore, join(target, ".gitignore"));
      await writeFile(gitignore, "", "utf8");
      await (await import("node:fs/promises")).rm(gitignore);
    }

    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.name = packageNameFrom(target);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const runner = packageManager();
    const install = runner === "yarn" ? "yarn" : `${runner} install`;
    const dev = runner === "npm" ? "npm run dev" : `${runner} dev`;

    log("");
    log(`Created ${manifest.name} in ${target} (${template}).`);
    log("");
    log("Next:");
    if (resolve(cwd) !== target) log(`  cd ${directoryName}`);
    log(`  ${install}`);
    log(`  ${dev}`);
    log("");
    log("The project already has the stylesheet import, a container with a height, an");
    log("attribution and one map. Open src/main.js and change the centre to your own city.");

    return { directory: target, template, name: manifest.name };
  } finally {
    rl?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.mjs")) {
  create(process.argv.slice(2)).catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  });
}
