import type { AIErrorCode, AIErrorDetails } from "./types.js";

function jsonSafeReceived(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[function${value.name ? ` ${value.name}` : ""}]`;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Structured public error used at the JSON/tool-calling boundary. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly path: string;
  readonly received?: unknown;

  constructor(code: AIErrorCode, path: string, message: string, received?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = "AIError";
    this.code = code;
    this.path = path;
    this.received = received;
  }

  toJSON(): AIErrorDetails {
    const received = jsonSafeReceived(this.received);
    return {
      code: this.code,
      path: this.path,
      message: this.message,
      ...(received === undefined ? {} : { received })
    };
  }
}

export function toAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const message = error instanceof Error ? error.message : "Orihon could not execute the AI command";
  return new AIError("EXECUTION_ERROR", "$", message, undefined, error instanceof Error ? { cause: error } : undefined);
}
