import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number.parseInt(process.env.ORIHON_DOCS_PORT ?? "4179", 10);
const host = process.env.ORIHON_DOCS_HOST ?? "127.0.0.1";
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"]
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(response, 400, "Bad request");
    }
    const candidate = resolve(root, `.${pathname}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) return send(response, 403, "Forbidden");
    let file = candidate;
    let info = await safeStat(file);
    if (info?.isDirectory()) {
      file = resolve(file, "index.html");
      info = await safeStat(file);
    }
    if (!info?.isFile()) return send(response, 404, "Not found");
    const extension = extname(file).toLowerCase();
    response.writeHead(200, {
      "Content-Type": types.get(extension) ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": extension === ".html" || extension === ".json" ? "no-store" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch (error) {
    send(response, 500, error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Orihon Developer Guide: http://${host}:${port}/examples/developer-guide/`);
});

function send(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(message);
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
