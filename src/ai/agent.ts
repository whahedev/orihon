import { AIError, toAIError } from "./errors.js";
import type { AIJSONSchema } from "./tool.js";
import type { AIErrorDetails, AIResult } from "./types.js";

export interface AILLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AILLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type AILLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: AILLMToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AILLMToolDefinition {
  name: string;
  description: string;
  inputSchema: AIJSONSchema;
}

export interface AILLMCompletionRequest {
  systemPrompt: string;
  messages: AILLMMessage[];
  tools: AILLMToolDefinition[];
}

export interface AILLMCompletion {
  content: string | null;
  toolCalls: AILLMToolCall[];
  usage: AILLMUsage;
  model?: string;
}

export interface AILLMAdapter {
  readonly provider: string;
  readonly model: string;
  complete(request: AILLMCompletionRequest, options?: { signal?: AbortSignal }): Promise<AILLMCompletion>;
}

export interface AILLMExecutableTool {
  readonly definition: AILLMToolDefinition;
  execute(input: unknown, options?: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

export interface AILLMAgentToolTrace {
  turn: number;
  id: string;
  name: string;
  arguments: unknown;
  result: unknown;
}

export interface AILLMAgentSuccess {
  provider: string;
  model: string;
  message: string;
  turns: number;
  usage: AILLMUsage;
  toolCalls: AILLMAgentToolTrace[];
}

export interface AILLMAgentOptions {
  adapter: AILLMAdapter;
  tools: AILLMExecutableTool[];
  systemPrompt: string;
  maxTurns?: number;
}

export interface AILLMAgent {
  run(message: string, options?: { signal?: AbortSignal }): Promise<AIResult<AILLMAgentSuccess>>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function usage(): AILLMUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function addUsage(total: AILLMUsage, next: AILLMUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
}

function toolContent(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  } catch {
    return JSON.stringify({ ok: false, error: { code: "EXECUTION_ERROR", message: "Tool result is not JSON-serializable" } });
  }
}

function toolFailure(error: unknown): { ok: false; error: AIErrorDetails } {
  return { ok: false, error: toAIError(error).toJSON() };
}

/** Provider-neutral, bounded tool loop. Map mutations still pass through each tool's own validator. */
export function createAILLMAgent(options: AILLMAgentOptions): AILLMAgent {
  if (!options?.adapter || typeof options.adapter.complete !== "function") {
    throw new TypeError("createAILLMAgent requires an adapter");
  }
  if (!Array.isArray(options.tools) || options.tools.length === 0) {
    throw new TypeError("createAILLMAgent requires at least one tool");
  }
  const maxTurns = options.maxTurns ?? 6;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 12) {
    throw new RangeError("maxTurns must be an integer from 1 to 12");
  }
  const tools = new Map<string, AILLMExecutableTool>();
  for (const tool of options.tools) {
    const name = tool?.definition?.name;
    if (typeof name !== "string" || name.trim() === "" || typeof tool.execute !== "function") {
      throw new TypeError("Every agent tool requires a name and execute function");
    }
    if (tools.has(name)) throw new TypeError(`Duplicate agent tool "${name}"`);
    tools.set(name, tool);
  }
  const definitions = [...tools.values()].map(({ definition }) => clone(definition));

  return Object.freeze({
    async run(message: string, runOptions: { signal?: AbortSignal } = {}): Promise<AIResult<AILLMAgentSuccess>> {
      try {
        if (typeof message !== "string" || message.trim() === "") {
          throw new AIError("INVALID_TYPE", "$message", "Expected a non-empty user message", message);
        }
        if (message.length > 8_000) {
          throw new AIError("INVALID_VALUE", "$message", "User message must not exceed 8000 characters", message.length);
        }
        const messages: AILLMMessage[] = [{ role: "user", content: message.trim() }];
        const totalUsage = usage();
        const traces: AILLMAgentToolTrace[] = [];

        for (let turn = 1; turn <= maxTurns; turn++) {
          if (runOptions.signal?.aborted) throw new DOMException("Agent request was aborted", "AbortError");
          const completion = await options.adapter.complete({
            systemPrompt: options.systemPrompt,
            messages: clone(messages),
            tools: clone(definitions)
          }, runOptions);
          addUsage(totalUsage, completion.usage);
          messages.push({
            role: "assistant",
            content: completion.content,
            ...(completion.toolCalls.length > 0 ? { toolCalls: clone(completion.toolCalls) } : {})
          });

          if (completion.toolCalls.length === 0) {
            return {
              ok: true,
              value: {
                provider: options.adapter.provider,
                model: completion.model ?? options.adapter.model,
                message: completion.content ?? "Готово.",
                turns: turn,
                usage: totalUsage,
                toolCalls: traces
              }
            };
          }

          for (const call of completion.toolCalls) {
            const tool = tools.get(call.name);
            const result = tool
              ? await Promise.resolve(tool.execute(clone(call.arguments), runOptions)).catch(toolFailure)
              : toolFailure(new AIError("NOT_FOUND", "$tool.name", `Tool "${call.name}" is not registered`, call.name));
            const safeResult = clone(result);
            traces.push({ turn, id: call.id, name: call.name, arguments: clone(call.arguments), result: safeResult });
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: toolContent(safeResult) });
          }
        }
        throw new AIError("EXECUTION_ERROR", "$agent.turns", `Model did not finish within ${maxTurns} turns`, maxTurns);
      } catch (error) {
        return { ok: false, error: toAIError(error).toJSON() };
      }
    }
  });
}
