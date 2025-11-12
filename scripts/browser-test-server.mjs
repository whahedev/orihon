import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

function resolvePath(urlPath) {
  const clean = decodeURIComponent((urlPath || "/").split("?")[0].split("#")[0]);
  const relativeUrl = clean === "/" ? "" : clean.replace(/^\/+/, "").replace(/\/+$/, "");
  const absolute = resolve(root, relativeUrl || ".");
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return absolute;
}

async function readStatic(filePath) {
  const info = await stat(filePath);
  const servedPath = info.isDirectory() ? join(filePath, "index.html") : filePath;
  const data = await readFile(servedPath);
  return { servedPath, data };
}

const server = createServer(async (req, res) => {
  try {
    const filePath = resolvePath(req.url || "/");
    if (!filePath) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const { servedPath, data } = await readStatic(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(servedPath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Orihon test server http://127.0.0.1:${port}/`);
});
