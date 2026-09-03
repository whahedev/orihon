import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ORIHON_AI_AGENT_SYSTEM_PROMPT,
  createAIAgentRuntime,
  createAICommandEngine,
  createAIHTTPHandler,
  createAIIntentTool,
  createAILLMAgent,
  createAIPlaceSearchTool,
  createNominatimPlaceSearchProvider,
  createOpenAICompatibleAdapter
} from "../../dist/ai-entry.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const port = Number(process.env.AI_DEMO_PORT ?? 4193);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const engine = createAICommandEngine();
const runtime = createAIAgentRuntime(engine);
const placeProvider = createNominatimPlaceSearchProvider({
  userAgent: process.env.ORIHON_NOMINATIM_USER_AGENT?.trim() || "Orihon-AI-Demo/2.0",
  minIntervalMs: Number(process.env.ORIHON_NOMINATIM_INTERVAL_MS ?? 1050)
});
const placeTool = createAIPlaceSearchTool(placeProvider);
const mapTool = createAIIntentTool(runtime);
const api = createAIHTTPHandler(engine, { runtime, placeSearch: placeTool });
const llmBaseURL = process.env.ORIHON_LLM_BASE_URL?.trim();
const llmModel = process.env.ORIHON_LLM_MODEL?.trim();
const llmConfigured = Boolean(llmBaseURL && llmModel);
const llmAgent = llmConfigured
  ? createAILLMAgent({
      adapter: createOpenAICompatibleAdapter({
        baseURL: llmBaseURL,
        model: llmModel,
        apiKey: process.env.ORIHON_LLM_API_KEY?.trim() || undefined,
        provider: process.env.ORIHON_LLM_PROVIDER?.trim() || "openai-compatible"
      }),
      tools: [
        placeTool,
        mapTool
      ],
      systemPrompt: `${ORIHON_AI_AGENT_SYSTEM_PROMPT}\n\n${mapTool.systemPrompt}`,
      maxTurns: 6
    })
  : undefined;

function writeJSON(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJSON(request, response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) {
      writeJSON(response, { ok: false, error: { code: "INVALID_VALUE", path: "$", message: "Request body is too large" } }, 413);
      return undefined;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    writeJSON(response, { ok: false, error: { code: "NOT_JSON", path: "$", message: "Request body must be valid JSON" } }, 400);
    return undefined;
  }
}

async function handleAgent(request, response) {
  if (request.method === "GET") {
    writeJSON(response, {
      configured: llmConfigured,
      provider: process.env.ORIHON_LLM_PROVIDER?.trim() || "openai-compatible",
      model: llmModel ?? null,
      placeSearch: "nominatim",
      requiredEnvironment: llmConfigured ? [] : ["ORIHON_LLM_BASE_URL", "ORIHON_LLM_MODEL"],
      apiKeyConfigured: Boolean(process.env.ORIHON_LLM_API_KEY?.trim())
    });
    return;
  }
  if (request.method !== "POST") {
    writeJSON(response, { ok: false, error: { code: "INVALID_VALUE", path: "$request.method", message: "Use GET or POST" } }, 405);
    return;
  }
  if (!llmAgent) {
    writeJSON(response, {
      ok: false,
      error: {
        code: "NOT_FOUND",
        path: "$agent.model",
        message: "Model is not configured. Set ORIHON_LLM_BASE_URL and ORIHON_LLM_MODEL, then restart the demo server. ORIHON_LLM_API_KEY is optional for local endpoints."
      }
    }, 503);
    return;
  }
  const body = await readJSON(request, response);
  if (body === undefined) return;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.message !== "string") {
    writeJSON(response, { ok: false, error: { code: "INVALID_TYPE", path: "$.message", message: "Expected {message: string}" } }, 400);
    return;
  }
  for (const key of Object.keys(body)) {
    if (key !== "message") {
      writeJSON(response, { ok: false, error: { code: "UNKNOWN_PROPERTY", path: `$.${key}`, message: `Unknown property "${key}"` } }, 400);
      return;
    }
  }
  const abort = new AbortController();
  request.once("aborted", () => abort.abort());
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  const result = await llmAgent.run(body.message, { signal: abort.signal });
  writeJSON(response, result, result.ok ? 200 : 502);
}

async function handleAPI(request, response) {
  const chunks = [];
  let length = 0;
  if (request.method === "POST") {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 1_000_000) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: { code: "INVALID_VALUE", path: "$", message: "Request body is too large" } }));
        return;
      }
      chunks.push(chunk);
    }
  }
  const abort = new AbortController();
  request.once("aborted", () => abort.abort());
  response.once("close", () => {
    if (!response.writableEnded) abort.abort();
  });
  const fetchRequest = new Request(`http://127.0.0.1:${port}${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    duplex: chunks.length ? "half" : undefined,
    signal: abort.signal
  });
  const result = await api(fetchRequest);
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (!result.body) response.end();
  else Readable.fromWeb(result.body).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (pathname.startsWith("/api/orihon/")) {
      await handleAPI(request, response);
      return;
    }
    if (pathname === "/api/agent" || pathname === "/api/agent/config") {
      await handleAgent(request, response);
      return;
    }
    const requested = pathname === "/" ? "/examples/ai-agent-demo/index.html" : pathname;
    let file = resolve(root, `.${requested}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error?.code === "ENOENT" ? "Not found" : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Orihon AI Agent Playground: http://127.0.0.1:${port}/examples/ai-agent-demo/`);
  console.log(`Command API: http://127.0.0.1:${port}/api/orihon`);
  console.log(`Model agent: ${llmConfigured ? `${process.env.ORIHON_LLM_PROVIDER?.trim() || "openai-compatible"} / ${llmModel}` : "not configured"}`);
});
