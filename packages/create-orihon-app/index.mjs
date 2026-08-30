#!/usr/bin/env node
// `npm create orihon-app` — scaffold a project that already draws a map.
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const templatesRoot = join(here, "templates");
const MIN_NODE_MAJOR = 20;
const FALLBACK_ORIHON = "^2.0.1";
const DOCS = {
  easy: "https://github.com/whahedev/orihon/blob/master/docs/EASY.md",
  api: "https://github.com/whahedev/orihon/blob/master/docs/API.md",
  trouble: "https://github.com/whahedev/orihon/blob/master/docs/TROUBLESHOOTING.md"
};

const TEMPLATES = [
  { id: "vanilla", label: "Vanilla — Vite + JavaScript" },
  { id: "vanilla-ts", label: "Vanilla — Vite + TypeScript" },
  { id: "react", label: "React — Vite + React 18" },
  { id: "react-ts", label: "React — Vite + TypeScript" },
  { id: "cdn", label: "CDN — one HTML file, no bundler" }
];

const RESERVED = new Set(["node_modules", "favicon.ico"]);
const DEFAULT_CENTER = { lat: 52.52, lng: 13.405 };

function parseArgs(argv) {
  const options = {
    directory: null,
    template: null,
    install: null,
    yes: false,
    center: null,
    locale: null
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--template" || arg === "-t") options.template = argv[++index];
    else if (arg.startsWith("--template=")) options.template = arg.slice("--template=".length);
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--install") options.install = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--center") options.center = argv[++index];
    else if (arg.startsWith("--center=")) options.center = arg.slice("--center=".length);
    else if (arg === "--locale") options.locale = argv[++index];
    else if (arg.startsWith("--locale=")) options.locale = arg.slice("--locale=".length);
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
    "  -t, --template <name>   vanilla | vanilla-ts | react | react-ts | cdn",
    "  -y, --yes               accept the defaults, ask nothing",
    "      --center <lat,lng>  map centre (default 52.52,13.405 — Berlin)",
    "      --locale <code>     map UI locale (default en)",
    "      --install           run the package install after scaffolding",
    "      --no-install        never run it",
    "  -h, --help              show this",
    "",
    "Examples:",
    "  npm create orihon-app my-map",
    "  npm create orihon-app my-map -- --template react-ts --yes --install",
    "  npm create orihon-app my-map -- --center 55.75,37.62 --locale ru"
  ].join("\n");
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR}+ is required (you have ${process.versions.node}). ` +
        `Upgrade Node, then run npm create orihon-app again.`
    );
  }
}

/** npm package names are stricter than directory names, and a bad one fails at install time. */
function packageNameFrom(directory) {
  const name = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-~][^a-z0-9-._~]*/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return name || "orihon-app";
}

function parseCenter(raw) {
  if (raw == null || raw === "") return { ...DEFAULT_CENTER };
  const parts = String(raw).split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) {
    throw new Error(`Invalid --center "${raw}". Use lat,lng (example: 55.75,37.62).`);
  }
  const [lat, lng] = parts;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`Invalid --center "${raw}". Latitude must be ±90 and longitude ±180.`);
  }
  return { lat, lng };
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

function resolveOrihonRange() {
  try {
    const result = spawnSync("npm", ["view", "orihon", "version", "--json"], {
      encoding: "utf8",
      shell: false
    });
    if (result.status === 0) {
      const version = JSON.parse(result.stdout.trim());
      if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
        return `^${version}`;
      }
    }
  } catch {
    /* offline / registry blip — keep the known good pin */
  }
  return FALLBACK_ORIHON;
}

function rewriteManifest(raw, { name, orihonRange, openDev }) {
  const manifest = JSON.parse(raw);
  manifest.name = name;
  if (manifest.dependencies?.orihon) manifest.dependencies.orihon = orihonRange;
  if (openDev && manifest.scripts?.dev === "vite") {
    manifest.scripts.dev = "vite --open";
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function cdnVersionFrom(range) {
  const match = String(range).match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : "2.0.1";
}

function rewriteText(raw, { center, locale, orihonRange }) {
  return raw
    .replaceAll("__ORIHON_CENTER_LAT__", String(center.lat))
    .replaceAll("__ORIHON_CENTER_LNG__", String(center.lng))
    .replaceAll("__ORIHON_LOCALE__", JSON.stringify(locale))
    .replaceAll("__ORIHON_CDN_VERSION__", cdnVersionFrom(orihonRange));
}

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

function runInstall(runner, directory, log) {
  log("");
  log(`Running ${runner === "yarn" ? "yarn" : `${runner} install`}…`);
  const args = runner === "yarn" ? [] : ["install"];
  const bin = runner === "yarn" ? "yarn" : runner;
  const result = spawnSync(bin, args, {
    cwd: directory,
    encoding: "utf8",
    shell: false,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(
      `Package install failed (exit ${result.status}). Run \`${runner === "yarn" ? "yarn" : `${runner} install`}\` in ${directory} yourself.`
    );
  }
}

export async function create(argv = [], { cwd = process.cwd(), interactive = true, log = console.log } = {}) {
  assertNodeVersion();
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

    let centerRaw = options.center;
    if (centerRaw == null && rl) {
      centerRaw = await ask(
        rl,
        `Map centre lat,lng (${DEFAULT_CENTER.lat},${DEFAULT_CENTER.lng}): `,
        `${DEFAULT_CENTER.lat},${DEFAULT_CENTER.lng}`
      );
    }
    const center = parseCenter(centerRaw ?? `${DEFAULT_CENTER.lat},${DEFAULT_CENTER.lng}`);

    let locale = options.locale;
    if (locale == null && rl) {
      locale = await ask(rl, "Map UI locale (en): ", "en");
    }
    locale ??= "en";

    const orihonRange = resolveOrihonRange();
    const isCdn = template === "cdn";

    await mkdir(target, { recursive: true });
    // `_gitignore` is shipped under a name npm will actually publish; every registry strips a
    // literal .gitignore out of the package tarball.
    await cp(join(templatesRoot, template), target, {
      recursive: true,
      filter: (source) => basename(source) !== "node_modules"
    });
    const gitignore = join(target, "_gitignore");
    if (existsSync(gitignore)) await rename(gitignore, join(target, ".gitignore"));

    const rewriteFiles = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          await rewriteFiles(path);
          continue;
        }
        if (!/\.(js|jsx|ts|tsx|html|css|json|md)$/.test(entry.name)) continue;
        const raw = await readFile(path, "utf8");
        if (entry.name === "package.json") {
          await writeFile(
            path,
            rewriteManifest(raw, {
              name: packageNameFrom(target),
              orihonRange,
              openDev: !isCdn
            }),
            "utf8"
          );
          continue;
        }
        if (raw.includes("__ORIHON_")) {
          await writeFile(path, rewriteText(raw, { center, locale, orihonRange }), "utf8");
        }
      }
    };
    await rewriteFiles(target);

    const runner = packageManager();
    const installCmd = runner === "yarn" ? "yarn" : `${runner} install`;
    const devCmd = isCdn
      ? (runner === "npm" ? "npx --yes serve ." : `${runner} dlx serve .`)
      : runner === "npm"
        ? "npm run dev"
        : `${runner} dev`;

    const shouldInstall = (() => {
      if (isCdn) return false;
      if (options.install === true) return true;
      if (options.install === false) return false;
      if (rl) return null; // ask below
      return false;
    })();
    const doInstall =
      shouldInstall === true ||
      (shouldInstall === null &&
        (await ask(rl, "Install packages now? (Y/n): ", "Y")).toLowerCase().startsWith("y"));

    if (doInstall) {
      runInstall(runner, target, log);
    }

    log("");
    log(`Created ${packageNameFrom(target)} in ${target} (${template}).`);
    log(`Centre ${center.lat},${center.lng} · locale ${locale} · orihon ${orihonRange}`);
    log("");
    log("Next:");
    if (resolve(cwd) !== target) log(`  cd ${directoryName}`);
    if (!doInstall && !isCdn) log(`  ${installCmd}`);
    log(`  ${devCmd}`);
    log("");
    log("Docs:");
    log(`  Easy API          ${DOCS.easy}`);
    log(`  API reference     ${DOCS.api}`);
    log(`  Troubleshooting   ${DOCS.trouble}`);
    log("");
    log("The project already draws a map and one sample of each Easy overlay.");
    log("Open the entry file, delete what you do not need, and point the centre at your city.");

    return {
      directory: target,
      template,
      name: packageNameFrom(target),
      center,
      locale,
      orihonRange,
      installed: doInstall
    };
  } finally {
    rl?.close();
  }
}

/**
 * `file://${argv[1]}` is not a URL on Windows — the path is `C:\…`, so the comparison never
 * matched and the CLI exited having done nothing. npm installs this file behind a `bin` shim, so
 * the entry point has to be recognised through whatever path that shim passes.
 */
function runningAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  create(process.argv.slice(2)).catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  });
}
