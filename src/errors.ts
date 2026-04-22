/**
 * Programmatic error contract shared by the whole library.
 *
 * Argument validation keeps using the platform types (`TypeError` for a wrong shape,
 * `RangeError` for an out-of-range or resource-limit value) — those are already
 * discriminable and every runtime understands them. `OrihonError` covers the cases the
 * platform has no type for: a capability that is not loaded, a resource used after its
 * terminal `destroy()`, a worker failure, an incompatible CRS. Callers branch on `code`,
 * never on the message text.
 */
export type OrihonErrorCode =
  | "ERR_UNSUPPORTED_CAPABILITY"
  | "ERR_DESTROYED"
  | "ERR_WORKER"
  | "ERR_CRS_INCOMPATIBLE"
  | "ERR_RESOURCE_LIMIT";

export interface OrihonErrorOptions extends ErrorOptions {
  /** Structured detail for logs and diagnostics; never part of the message string. */
  context?: Record<string, unknown>;
}

export class OrihonError extends Error {
  readonly code: OrihonErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: OrihonErrorCode, message: string, options: OrihonErrorOptions = {}) {
    const { context, ...errorOptions } = options;
    super(message, errorOptions);
    this.name = "OrihonError";
    this.code = code;
    if (context) this.context = context;
  }
}

/** A tier or optional entry that provides the requested feature was never imported. */
export class UnsupportedCapabilityError extends OrihonError {
  constructor(message: string, options?: OrihonErrorOptions) {
    super("ERR_UNSUPPORTED_CAPABILITY", message, options);
    this.name = "UnsupportedCapabilityError";
  }
}

/**
 * A new operation was requested on an owned resource after its terminal `destroy()`.
 *
 * This is deliberately not an `AbortError`. The two answer different questions: `AbortError`
 * means "the operation you started was stopped", and the work may be retried on a resource that
 * is still usable; `DestroyedError` means "the resource you called is gone", and no retry can
 * succeed. Reporting both the same way forces callers to guess which one they got.
 */
export class DestroyedError extends OrihonError {
  constructor(message: string, options?: OrihonErrorOptions) {
    super("ERR_DESTROYED", message, options);
    this.name = "DestroyedError";
  }
}
