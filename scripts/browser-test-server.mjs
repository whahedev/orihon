import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.ORIHON_PORT || 4389);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wasm": "application/wasm"
};

const SKIP_DIRS = new Set(["node_modules", ".git", "test-results", "playwright-report"]);

function resolvePath(urlPath) {
  const clean = decodeURIComponent((urlPath || "/").split("?")[0].split("#")[0]);
  const relativeUrl = clean === "/" ? "" : clean.replace(/^\/+/, "").replace(/\/+$/, "");
  const absolute = resolve(root, relativeUrl || ".");
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return { absolute, clean: clean || "/" };
}

function headers(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };
}

function landingHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orihon test server</title>
    <style>
      body { margin: 24px; font: 15px/1.45 system-ui, sans-serif; color: #e8eef4; background: #071018; }
      a { color: #2dd4bf; }
      .grid { display: grid; gap: 10px; max-width: 720px; }
      .card { display: block; padding: 12px 14px; border: 1px solid #243044; border-radius: 10px; text-decoration: none; color: inherit; }
      .card:hover { border-color: #2dd4bf; }
      h1 { font-size: 1.25rem; }
      p { color: #93a4b5; }
      .muted { color: #93a4b5; font-size: 13px; }
    </style>
  </head>
  <body>
    <h1>Orihon test server</h1>
    <p>Локальные страницы для скорости ObjectManager, визуальных контрактов и демо.</p>
    <div class="grid">
      <a class="card" href="/test/object-manager-speed.html">
        <strong>ObjectManager speed</strong>
        <div class="muted">Ingest / layout / animate subset · 25k–1M</div>
      </a>
      <a class="card" href="/test/object-manager-speed.html?count=100000&amp;moving=2000&amp;autorun=1">
        <strong>Speed autorun · 100k + 2k moving</strong>
        <div class="muted">Сразу прогон с анимацией части точек</div>
      </a>
      <a class="card" href="/examples/object-manager-live/">
        <strong>ObjectManager live</strong>
        <div class="muted">IoT 15k–1M · FPS/heap · color pulse · popups · aircraft</div>
      </a>
      <a class="card" href="/examples/object-manager-scene/">
        <strong>ObjectManager scene lab</strong>
        <div class="muted">Icons / labels / stress 1M / Animate 2k</div>
      </a>
      <a class="card" href="/examples/bench-compare/">Benchmark compare</a>
      <a class="card" href="/test/p1-browser-acceptance.html">P1 browser acceptance</a>
      <a class="card" href="/test/fixtures/visual.html">Visual contract</a>
      <a class="card" href="/test/">/test/ listing</a>
      <a class="card" href="/examples/">/examples/ listing</a>
    </div>
  </body>
</html>`;
}

function listingHtml(title, entries) {
  const items = entries
    .map((name) => `<li><a href="${name}">${name}</a></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${title}</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#071018;color:#e8eef4}a{color:#2dd4bf}</style>
</head><body><h1>${title}</h1><ul>${items}</ul></body></html>`;
}

async function directoryListing(dirPath, urlPath) {
  const names = (await readdir(dirPath))
    .filter((name) => !SKIP_DIRS.has(name) && !name.startsWith("."))
    .sort();
  const entries = [];
  for (const name of names) {
    const info = await stat(join(dirPath, name));
    entries.push(info.isDirectory() ? `${name}/` : name);
  }
  const prefix = urlPath.endsWith("/") ? urlPath : `${urlPath}/`;
  return listingHtml(prefix, entries);
}

export function createOrihonTestServer() {
  return createServer(async (req, res) => {
    try {
      const resolved = resolvePath(req.url || "/");
      if (!resolved) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const { absolute, clean } = resolved;
      if (clean === "/") {
        res.writeHead(200, headers("text/html; charset=utf-8")).end(landingHtml());
        return;
      }
      const info = await stat(absolute);
      if (info.isDirectory()) {
        try {
          const indexPath = join(absolute, "index.html");
          const index = await readFile(indexPath);
          res.writeHead(200, headers("text/html; charset=utf-8")).end(index);
          return;
        } catch {
          const html = await directoryListing(absolute, clean);
          res.writeHead(200, headers("text/html; charset=utf-8")).end(html);
          return;
        }
      }
      let data;
      try {
        data = await readFile(absolute);
      } catch (err) {
        const distRoot = join(root, "dist");
        const rel = relative(distRoot, absolute);
        if (rel.startsWith("..") || rel.split(sep).includes("..")) throw err;
        data = await readFile(join(distRoot, "bundle-tmp", rel));
      }
      res.writeHead(200, headers(TYPES[extname(absolute)] || "application/octet-stream")).end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const server = createOrihonTestServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Orihon test server http://127.0.0.1:${port}/`);
    console.log(`  speed  http://127.0.0.1:${port}/test/object-manager-speed.html`);
  });
}
