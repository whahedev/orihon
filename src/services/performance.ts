import { Evented } from "../events.js";
import type { Orihon } from "../map.js";

export interface PerformanceSnapshot {
  timestamp: number;
  fps: number | null;
  frameMs: number | null;
  domNodes: number;
  layers: number;
  controls: number;
  tiles: {
    active: number;
    retained: number;
    cached: number;
  };
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
}

export interface PerformanceInspectorOptions {
  sampleFrames?: number;
  includeMemory?: boolean;
}

export interface PerformanceEventMap {
  measure: { snapshot: PerformanceSnapshot };
  sample: { snapshot: PerformanceSnapshot };
}

export class PerformanceInspector extends Evented<PerformanceEventMap> {
  readonly map: Orihon;
  readonly options: Required<PerformanceInspectorOptions>;
  _running = false;
  _frame = 0;

  constructor(map: Orihon, options: PerformanceInspectorOptions = {}) {
    super();
    this.map = map;
    this.options = {
      sampleFrames: Math.max(2, Math.floor(options.sampleFrames ?? 30)),
      includeMemory: options.includeMemory !== false
    };
  }

  snapshot(): PerformanceSnapshot {
    return this.#snapshot(null, null);
  }

  async measureFrames(sampleFrames = this.options.sampleFrames): Promise<PerformanceSnapshot> {
    const count = Math.max(2, Math.floor(sampleFrames));
    if (typeof requestAnimationFrame !== "function") return this.snapshot();
    const deltas: number[] = [];
    let last = 0;
    await new Promise<void>((resolve) => {
      const step = (time: number) => {
        if (last) deltas.push(time - last);
        last = time;
        if (deltas.length >= count) resolve();
        else this._frame = requestAnimationFrame(step);
      };
      this._frame = requestAnimationFrame(step);
    });
    const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const snapshot = this.#snapshot(average ? 1000 / average : null, average || null);
    this.emit("measure", { snapshot });
    return snapshot;
  }

  start(intervalMs = 1000): this {
    if (this._running) return this;
    this._running = true;
    const loop = async () => {
      if (!this._running) return;
      const snapshot = await this.measureFrames();
      this.emit("sample", { snapshot });
      setTimeout(loop, intervalMs);
    };
    void loop();
    return this;
  }

  stop(): this {
    this._running = false;
    if (this._frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._frame);
    this._frame = 0;
    return this;
  }

  #snapshot(fps: number | null, frameMs: number | null): PerformanceSnapshot {
    let activeTiles = 0;
    let retainedTiles = 0;
    let cachedTiles = 0;
    for (const layer of this.map.layers) {
      const maybeTileLayer = layer as unknown as {
        tiles?: Map<unknown, unknown>;
        previousTiles?: Map<unknown, unknown>;
        cache?: Map<unknown, unknown>;
      };
      activeTiles += maybeTileLayer.tiles?.size ?? 0;
      retainedTiles += maybeTileLayer.previousTiles?.size ?? 0;
      cachedTiles += maybeTileLayer.cache?.size ?? 0;
    }
    const memory = this.options.includeMemory
      ? (performance as Performance & { memory?: PerformanceSnapshot["memory"] }).memory
      : undefined;
    return {
      timestamp: Date.now(),
      fps,
      frameMs,
      domNodes: this.map.container.querySelectorAll("*").length,
      layers: this.map.layers.size,
      controls: this.map.controls.size,
      tiles: {
        active: activeTiles,
        retained: retainedTiles,
        cached: cachedTiles
      },
      memory: memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit
      } : undefined
    };
  }
}

export function performanceInspector(map: Orihon, options?: PerformanceInspectorOptions): PerformanceInspector {
  return new PerformanceInspector(map, options);
}
