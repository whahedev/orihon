import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
// 8788 — рядом с Air+Sea Radar на 8787 в этом репозитории.
const PORT = Number(process.env.PORT || 8788);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  const body = Buffer.from(text, "utf8");

  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || HOST}`
    );

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      sendText(res, 404, "Not found");
      return;
    }

    const body = await fs.readFile(
      path.join(__dirname, "index.html")
    );

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });

    res.end(body);
  } catch (error) {
    console.error(error);

    sendText(
      res,
      500,
      error instanceof Error
        ? error.stack || error.message
        : String(error)
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("РЖД 121В/122В tracker запущен.");
  console.log(`Откройте: http://${HOST}:${PORT}`);
  console.log("");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
