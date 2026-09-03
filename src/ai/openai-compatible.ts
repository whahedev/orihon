import { AIError } from "./errors.js";
import type {
  AILLMAdapter,
  AILLMCompletion,
  AILLMCompletionRequest,
  AILLMMessage,
  AILLMToolCall
} from "./agent.js";

export interface OpenAICompatibleAdapterOptions {
  /** API root such as https://host.example/v1. */
  baseURL: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  provider?: string;
}

function endpoint(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function message(value: AILLMMessage): Record<string, unknown> {
  if (value.role === "assistant") {
    return {
      role: "assistant",
      content: value.content,
      ...(value.toolCalls ? {
        tool_calls: value.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      } : {})
    };
  }
  if (value.role === "tool") {
    return { role: "tool", tool_call_id: value.toolCallId, name: value.name, content: value.content };
  }
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIError("EXECUTION_ERROR", path, "Model returned an invalid response", value);
  }
  return value as Record<string, unknown>;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

function toolCalls(value: unknown): AILLMToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AIError("EXECUTION_ERROR", "$response.choices[0].message.tool_calls", "Expected an array", value);
  return value.map((item, index) => {
    const source = record(item, `$response.choices[0].message.tool_calls[${index}]`);
    const fn = record(source.function, `$response.choices[0].message.tool_calls[${index}].function`);
    if (typeof source.id !== "string" || typeof fn.name !== "string") {
      throw new AIError("EXECUTION_ERROR", `$response.choices[0].message.tool_calls[${index}]`, "Tool call requires string id and function.name", item);
    }
    return { id: source.id, name: fn.name, arguments: parseArguments(fn.arguments) };
  });
}

/** Chat Completions transport shared by many hosted and local model servers. */
export function createOpenAICompatibleAdapter(options: OpenAICompatibleAdapterOptions): AILLMAdapter {
  if (typeof options?.baseURL !== "string" || options.baseURL.trim() === "") throw new TypeError("baseURL is required");
  if (typeof options.model !== "string" || options.model.trim() === "") throw new TypeError("model is required");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("A Fetch-compatible implementation is required");
  const url = endpoint(options.baseURL);

  return Object.freeze({
    provider: options.provider ?? "openai-compatible",
    model: options.model,
    async complete(request: AILLMCompletionRequest, runOptions: { signal?: AbortSignal } = {}): Promise<AILLMCompletion> {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "system", content: request.systemPrompt }, ...request.messages.map(message)],
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
          })),
          tool_choice: "auto"
        }),
        signal: runOptions.signal
      });
      const text = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(text) as unknown; }
      catch { throw new AIError("EXECUTION_ERROR", "$response", `Model endpoint returned non-JSON HTTP ${response.status}`, text.slice(0, 500)); }
      if (!response.ok) {
        const source = record(payload, "$response");
        const detail = source.error && typeof source.error === "object" ? record(source.error, "$response.error").message : undefined;
        throw new AIError("EXECUTION_ERROR", "$response", `Model endpoint returned HTTP ${response.status}${typeof detail === "string" ? `: ${detail}` : ""}`);
      }
      const source = record(payload, "$response");
      if (!Array.isArray(source.choices) || source.choices.length === 0) {
        throw new AIError("EXECUTION_ERROR", "$response.choices", "Model response has no choices", source.choices);
      }
      const choice = record(source.choices[0], "$response.choices[0]");
      const assistant = record(choice.message, "$response.choices[0].message");
      const rawUsage = source.usage && typeof source.usage === "object" ? record(source.usage, "$response.usage") : {};
      const promptDetails = rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === "object"
        ? record(rawUsage.prompt_tokens_details, "$response.usage.prompt_tokens_details")
        : {};
      return {
        content: typeof assistant.content === "string" ? assistant.content : null,
        toolCalls: toolCalls(assistant.tool_calls),
        usage: {
          inputTokens: typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0,
          outputTokens: typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0,
          cachedInputTokens: typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0
        },
        ...(typeof source.model === "string" ? { model: source.model } : {})
      };
    }
  });
}
