/**
 * Embed example JS/CSS into single HTML files so GitHub downloads open on file://.
 * Chrome blocks relative ES module imports from file://; CDN + inline modules work.
 *
 * Usage: node scripts/embed-examples.mjs
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Pinned to the version being released, read from package.json so a release cannot leave a
// demo pointing at the previous one. test/benchmark-contract.test.js asserts the match.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const CDN_BASE = `https://cdn.jsdelivr.net/npm/orihon@${version}/dist`;
const CDN_JS = `${CDN_BASE}/orihon.esm.js`;
const CDN_CSS = `${CDN_BASE}/orihon.css`;
const CDN_GLOBAL = `${CDN_BASE}/orihon.global.js`;

function patchLoadOrihon(source, { withBenchLink = false } = {}) {
  const benchLink = withBenchLink
    ? `
  els.bench.href =
    location.protocol === "file:"
      ? new URL("../bench-compare/index.html", import.meta.url).href
      : location.pathname.includes("/examples/showcase")
        ? "/examples/bench-compare/"
        : "../bench/";`
    : "";

  const next = `async function loadOrihon() {
  const ORIHON_CDN = ${JSON.stringify(CDN_JS)};
  const ORIHON_CDN_CSS = ${JSON.stringify(CDN_CSS)};
  const link =
    document.getElementById("orihon-css") ||
    document.querySelector("link[data-orihon-css]");${benchLink}
  const http = location.protocol === "http:" || location.protocol === "https:";
  if (http) {
    const localBuild = "?bench=" + Date.now().toString(36);
    try {
      const mod = await import("/dist/orihon.esm.js" + localBuild);
      if (link) link.href = "/dist/orihon.css" + localBuild;
      return mod;
    } catch {
      try {
        const mod = await import("/dist/index.js" + localBuild);
        if (link) link.href = "/dist/orihon.css" + localBuild;
        return mod;
      } catch {
        /* fall through to CDN */
      }
    }
  }
  if (link) link.href = ORIHON_CDN_CSS;
  return import(ORIHON_CDN);
}`;

  if (/async function loadOrihon\s*\(/.test(source)) {
    return source.replace(/async function loadOrihon\s*\([^)]*\)\s*\{[\s\S]*?\n\}/, next);
  }
  return `${next}\n\n${source}`;
}

async function readMaybe(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function extractEmbed(html, name) {
  const re = new RegExp(
    `<!-- EMBED:${name} -->\\s*<script type="module">\\r?\\n([\\s\\S]*?)\\r?\\n\\s*</script>\\s*<!-- /EMBED:${name} -->`
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function extractStyleEmbed(html, name) {
  const re = new RegExp(
    `<!-- EMBED:${name} -->\\s*<style>\\r?\\n([\\s\\S]*?)\\r?\\n\\s*</style>\\s*<!-- /EMBED:${name} -->`
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function setScriptEmbed(html, name, code, srcFallback) {
  const block = `<!-- EMBED:${name} -->\n    <script type="module">\n${code.trim()}\n    </script>\n    <!-- /EMBED:${name} -->`;
  if (html.includes(`<!-- EMBED:${name} -->`)) {
    return html.replace(
      new RegExp(`<!-- EMBED:${name} -->[\\s\\S]*?<!-- /EMBED:${name} -->`),
      block
    );
  }
  if (srcFallback && html.includes(srcFallback)) {
    return html.replace(srcFallback, block);
  }
  throw new Error(`Cannot place embed ${name}`);
}

function setStyleEmbed(html, name, css, hrefFallback) {
  const block = `<!-- EMBED:${name} -->\n    <style>\n${css.trim()}\n    </style>\n    <!-- /EMBED:${name} -->`;
  if (html.includes(`<!-- EMBED:${name} -->`)) {
    return html.replace(
      new RegExp(`<!-- EMBED:${name} -->[\\s\\S]*?<!-- /EMBED:${name} -->`),
      block
    );
  }
  if (hrefFallback && html.includes(hrefFallback)) {
    return html.replace(hrefFallback, block);
  }
  throw new Error(`Cannot place style embed ${name}`);
}

async function embedShowcase() {
  const dir = join(root, "examples/showcase");
  let html = await readFile(join(dir, "index.html"), "utf8");
  let app =
    (await readMaybe(join(dir, "app.js"))) ||
    extractEmbed(html, "showcase-app");
  if (!app) throw new Error("showcase: no app.js source");
  app = patchLoadOrihon(app, { withBenchLink: true });
  html = setScriptEmbed(
    html,
    "showcase-app",
    app,
    '<script type="module" src="./app.js"></script>'
  );
  await writeFile(join(dir, "index.html"), html);
  await unlink(join(dir, "app.js")).catch(() => {});
  console.log("showcase: self-contained HTML");
}

async function embedBench() {
  const dir = join(root, "examples/bench-compare");
  let html = await readFile(join(dir, "index.html"), "utf8");

  let css =
    (await readMaybe(join(dir, "bench.css"))) ||
    extractStyleEmbed(html, "bench-css");
  if (!css) throw new Error("bench: no css source");

  let raw = await readMaybe(join(dir, "maplibre-raw.js"));
  let rich = await readMaybe(join(dir, "maplibre-rich.js"));
  let app = await readMaybe(join(dir, "app.js"));

  if (!app) {
    const embedded = extractEmbed(html, "bench-app");
    if (!embedded) throw new Error("bench: no app source");
    // Already a merged module — just re-patch loader
    app = patchLoadOrihon(embedded, { withBenchLink: false });
    html = setStyleEmbed(html, "bench-css", css, '<link rel="stylesheet" href="./bench.css" />');
    html = setScriptEmbed(html, "bench-app", app, null);
  } else {
    raw = raw || "";
    rich = rich || "";
    raw = raw.replace(/^export function createMapLibreRawPoints/m, "function createMapLibreRawPoints");
    rich = rich.replace(/^export function createMapLibreRichPoints/m, "function createMapLibreRichPoints");
    app = app
      .replace(/^import \{ createMapLibreRawPoints \} from "\.\/maplibre-raw\.js";\r?\n/m, "")
      .replace(/^import \{ createMapLibreRichPoints \} from "\.\/maplibre-rich\.js";\r?\n/m, "");
    app = patchLoadOrihon(app, { withBenchLink: false });
    app = app.replace(
      /^const ORIHON_CDN = [\s\S]*?^const ORIHON_CDN_CSS = .*?\r?\n\r?\n/m,
      ""
    );
    const module = `${raw.trim()}\n\n${rich.trim()}\n\n${app.trim()}\n`;
    html = setStyleEmbed(html, "bench-css", css, '<link rel="stylesheet" href="./bench.css" />');
    html = setScriptEmbed(
      html,
      "bench-app",
      module,
      '<script type="module" src="./app.js"></script>'
    );
  }

  await writeFile(join(dir, "index.html"), html);
  for (const name of ["app.js", "maplibre-raw.js", "maplibre-rich.js", "bench.css"]) {
    await unlink(join(dir, name)).catch(() => {});
  }
  console.log("bench-compare: self-contained HTML");
}

async function fixPlanetary() {
  const dir = join(root, "examples/planetary-demo");
  let html = await readFile(join(dir, "index.html"), "utf8");
  html = html
    .replace(/href="[^"]*orihon\.css"/g, `href="${CDN_CSS}"`)
    .replace(/src="[^"]*orihon\.global\.js"/g, `src="${CDN_GLOBAL}"`);
  await writeFile(join(dir, "index.html"), html);
  for (const name of ["orihon.css", "orihon.global.js"]) {
    await unlink(join(dir, name)).catch(() => {});
  }
  console.log("planetary-demo: CDN assets");
}

await embedShowcase();
await embedBench();
await fixPlanetary();
