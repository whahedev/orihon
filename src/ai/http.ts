import type { AICommandEngine } from "./engine.js";
import { createAIAgentRuntime, type AIAgentRuntime } from "./runtime.js";
import type { AIPlaceSearchSuccess } from "./place-search.js";
import type { AIEngineExecuteOptions, AIIntentCommitSuccess, AIResult } from "./types.js";

export interface AIHTTPPlaceSearch {
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<AIResult<AIPlaceSearchSuccess>>;
}

export interface AIHTTPHandlerOptions {
  /** Endpoint prefix. Default: /api/orihon */
  basePath?: string;
  /** Reuse a host-configured semantic runtime/capability registry. */
  runtime?: AIAgentRuntime;
  /** Intent HTTP responses. Default compact (no echoed point payloads). */
  intentResultMode?: "compact" | "full";
  /**
   * Place search used by POST /places. External agents call this instead of
   * importing Nominatim. Optional: without it the endpoint returns 503.
   */
  placeSearch?: AIHTTPPlaceSearch;
}

export type AIHTTPHandler = (request: Request) => Promise<Response>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function compactIntentResult(result: AIResult<{
  plan: { goal: AIIntentCommitSuccess["goal"] };
  revision: number;
  resources: AIIntentCommitSuccess["resources"];
  context: AIIntentCommitSuccess["context"];
}>): AIResult<AIIntentCommitSuccess> {
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      goal: result.value.plan.goal,
      revision: result.value.revision,
      resources: result.value.resources,
      context: result.value.context
    }
  };
}

/**
 * Standards-based HTTP adapter for Fetch-compatible servers and edge runtimes.
 * Host applications remain responsible for authentication, authorization, rate
 * limits, persistence and choosing the map/tenant-specific engine instance.
 */
export function createAIHTTPHandler(engine: AICommandEngine, options: AIHTTPHandlerOptions = {}): AIHTTPHandler {
  if (!engine || typeof engine.execute !== "function") throw new TypeError("createAIHTTPHandler(engine) requires an AICommandEngine");
  const basePath = (options.basePath ?? "/api/orihon").replace(/\/$/, "");
  const runtime = options.runtime ?? createAIAgentRuntime(engine);
  const defaultIntentMode = options.intentResultMode ?? "compact";
  const placeSearch = options.placeSearch;
  const encoder = new TextEncoder();

  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === `${basePath}/capabilities`) {
      return jsonResponse({
        version: 1,
        capabilities: runtime.describeCapabilities(),
        interfaces: {
          http: {
            places: { method: "POST", path: `${basePath}/places` },
            intents: { method: "POST", path: `${basePath}/intents` }
          },
          llmTools: ["orihon_search_places", "orihon_plan"],
          placeSearch: Boolean(placeSearch)
        }
      });
    }
    if (request.method === "GET" && pathname === `${basePath}/context`) {
      return jsonResponse(runtime.getContext());
    }
    if (request.method === "GET" && pathname === `${basePath}/snapshot`) {
      return jsonResponse(engine.getSnapshot());
    }
    if (request.method === "POST" && pathname === `${basePath}/places`) {
      if (!placeSearch) {
        return jsonResponse({
          ok: false,
          error: {
            code: "NOT_FOUND",
            path: "$placeSearch",
            message: "Place search is not configured on this HTTP adapter. Pass placeSearch to createAIHTTPHandler."
          }
        }, 503);
      }
      let body: unknown;
      try { body = await request.json(); }
      catch { return jsonResponse({ ok: false, error: { code: "NOT_JSON", path: "$", message: "Request body must be valid JSON" } }, 400); }
      const result = await placeSearch.execute(body, { signal: request.signal });
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    if (request.method === "POST" && pathname === `${basePath}/commands`) {
      let body: unknown;
      try { body = await request.json(); }
      catch { return jsonResponse({ ok: false, error: { code: "NOT_JSON", path: "$", message: "Request body must be valid JSON" } }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ ok: false, error: { code: "INVALID_TYPE", path: "$", message: "Expected {command, baseRevision?}" } }, 400);
      }
      const envelope = body as Record<string, unknown>;
      for (const key of Object.keys(envelope)) {
        if (key !== "command" && key !== "baseRevision") {
          return jsonResponse({ ok: false, error: { code: "UNKNOWN_PROPERTY", path: `$.${key}`, message: `Unknown property "${key}"` } }, 400);
        }
      }
      if (!("command" in envelope)) {
        return jsonResponse({ ok: false, error: { code: "REQUIRED_PROPERTY", path: "$.command", message: "Required property \"command\" is missing" } }, 400);
      }
      const executeOptions: AIEngineExecuteOptions = {};
      if (envelope.baseRevision !== undefined) {
        if (typeof envelope.baseRevision !== "number") {
          return jsonResponse({ ok: false, error: { code: "INVALID_TYPE", path: "$.baseRevision", message: "Expected a number" } }, 400);
        }
        executeOptions.baseRevision = envelope.baseRevision;
      }
      const result = engine.execute(envelope.command, executeOptions);
      return jsonResponse(result, result.ok ? 200 : result.error.code === "REVISION_CONFLICT" ? 409 : 400);
    }
    if (request.method === "POST" && (pathname === `${basePath}/intents` || pathname === `${basePath}/intents/preview`)) {
      let body: unknown;
      try { body = await request.json(); }
      catch { return jsonResponse({ ok: false, error: { code: "NOT_JSON", path: "$", message: "Request body must be valid JSON" } }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ ok: false, error: { code: "INVALID_TYPE", path: "$", message: "Expected {intent, baseRevision?, resultMode?}" } }, 400);
      }
      const envelope = body as Record<string, unknown>;
      for (const key of Object.keys(envelope)) {
        if (key !== "intent" && key !== "baseRevision" && key !== "resultMode") {
          return jsonResponse({ ok: false, error: { code: "UNKNOWN_PROPERTY", path: `$.${key}`, message: `Unknown property "${key}"` } }, 400);
        }
      }
      if (!("intent" in envelope)) {
        return jsonResponse({ ok: false, error: { code: "REQUIRED_PROPERTY", path: "$.intent", message: "Required property \"intent\" is missing" } }, 400);
      }
      if (envelope.baseRevision !== undefined && typeof envelope.baseRevision !== "number") {
        return jsonResponse({ ok: false, error: { code: "INVALID_TYPE", path: "$.baseRevision", message: "Expected a number" } }, 400);
      }
      const resultMode = envelope.resultMode === "full" || envelope.resultMode === "compact"
        ? envelope.resultMode
        : defaultIntentMode;
      if (envelope.resultMode !== undefined && envelope.resultMode !== "full" && envelope.resultMode !== "compact") {
        return jsonResponse({ ok: false, error: { code: "INVALID_VALUE", path: "$.resultMode", message: "Expected compact or full", received: envelope.resultMode } }, 400);
      }
      const planned = runtime.plan(envelope.intent, {
        ...(typeof envelope.baseRevision === "number" ? { baseRevision: envelope.baseRevision } : {})
      });
      const result = !planned.ok
        ? planned
        : pathname.endsWith("/preview")
          ? runtime.preview(planned.value)
          : runtime.commit(planned.value);
      if (!result.ok) {
        return jsonResponse(result, result.error.code === "REVISION_CONFLICT" ? 409 : 400);
      }
      if (resultMode === "full") {
        return jsonResponse(result, 200);
      }
      if (pathname.endsWith("/preview")) {
        return jsonResponse({
          ok: true,
          value: {
            goal: result.value.plan.goal,
            revision: result.value.revision,
            resources: result.value.resources,
            context: result.value.context,
            plan: result.value.plan
          }
        }, 200);
      }
      return jsonResponse(compactIntentResult(result), 200);
    }
    if (request.method === "GET" && pathname === `${basePath}/events`) {
      let unsubscribe: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ revision: engine.revision })}\n\n`));
          unsubscribe = engine.subscribe((event) => {
            controller.enqueue(encoder.encode(`id: ${event.revision}\nevent: command\ndata: ${JSON.stringify(event)}\n\n`));
          });
          request.signal.addEventListener("abort", () => {
            unsubscribe?.();
            unsubscribe = undefined;
            try { controller.close(); } catch { /* stream may already be closed */ }
          }, { once: true });
        },
        cancel() {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive"
        }
      });
    }
    return jsonResponse({ ok: false, error: { code: "NOT_FOUND", path: "$request.url", message: "Orihon AI endpoint not found" } }, 404);
  };
}
