/** Internal request lifetime; providers may ignore cancellation, consumers must not hang. */
export function abortError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export class AbortableOperation {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  #unlink: (() => void) | null = null;

  constructor(readonly label: string, external?: AbortSignal) {
    if (!external) return;
    const abort = (): void => this.cancel(external.reason);
    if (external.aborted) abort();
    else {
      external.addEventListener("abort", abort, { once: true });
      this.#unlink = () => external.removeEventListener("abort", abort);
    }
  }

  cancel(cause?: unknown): void {
    if (!this.signal.aborted) this.#controller.abort(abortError(`${this.label} was cancelled`, cause));
    this.dispose();
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }

  run<T>(work: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        this.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => { cleanup(); reject(this.signal.reason); };
      if (this.signal.aborted) { onAbort(); return; }
      this.signal.addEventListener("abort", onAbort, { once: true });
      try {
        // Both handlers stay attached after abort: late provider rejections are consumed.
        Promise.resolve(work()).then(
          (value) => {
            cleanup();
            if (this.signal.aborted) reject(this.signal.reason);
            else resolve(value);
          },
          (error) => { cleanup(); reject(this.signal.aborted ? this.signal.reason : error); }
        );
      } catch (error) {
        cleanup();
        reject(this.signal.aborted ? this.signal.reason : error);
      }
    });
  }

  dispose(): void {
    this.#unlink?.();
    this.#unlink = null;
  }
}
