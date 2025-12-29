export type AsyncBatchYieldMode = "frame" | "task";

export interface AsyncBatchOptions {
  /** Input items processed between main-thread task boundaries. */
  chunkSize?: number;
  /** Yield on an animation frame (default) or a continuation task. */
  yieldMode?: AsyncBatchYieldMode;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number | null) => void;
}

export interface ResolvedAsyncBatchOptions {
  chunkSize: number;
  yieldMode: AsyncBatchYieldMode;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number | null) => void;
}

export function resolveAsyncBatchOptions(
  options: AsyncBatchOptions,
  defaultChunkSize: number
): ResolvedAsyncBatchOptions {
  return {
    chunkSize: Math.max(1, Math.floor(Number(options.chunkSize) || defaultChunkSize)),
    yieldMode: options.yieldMode === "task" ? "task" : "frame",
    signal: options.signal,
    onProgress: options.onProgress
  };
}

export function asyncAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Asynchronous ingestion aborted", "AbortError");
  const error = new Error("Asynchronous ingestion aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAsyncAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw asyncAbortError();
}

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

/** Yield without the nested setTimeout clamp when the platform supports it. */
export function yieldAsyncBatch(mode: AsyncBatchYieldMode): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (mode === "task" && scheduler?.yield) return scheduler.yield();
  if (mode === "task" && typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }
  if (mode === "frame" && typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
