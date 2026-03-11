import { TileLayer, type TileLayerOptions, type TileTemplate } from "../layers/tile-layer.js";
import type { Orihon } from "../map.js";

export type TrafficState = "idle" | "loading" | "ready" | "error";

export interface TrafficLayerOptions extends TileLayerOptions {
  dataTime?: Date | string | number | null;
  refreshIntervalMs?: number;
}

export interface TrafficEventMap {
  datatimechange: { dataTime: Date | null };
  refresh: { dataTime: Date | null };
  statechange: { state: TrafficState; dataTime: Date | null };
}

export class TrafficLayer extends TileLayer<TrafficEventMap> {
  state: TrafficState = "idle";
  dataTime: Date | null;
  refreshIntervalMs: number;
  _refreshTimer: ReturnType<typeof setInterval> | null = null;
  _pendingTiles = 0;

  constructor(provider: TileTemplate, options: TrafficLayerOptions = {}) {
    super(provider, { opacity: 0.65, maxZoom: 19, ...options });
    this.dataTime = options.dataTime == null ? null : new Date(options.dataTime);
    this.refreshIntervalMs = Math.max(0, Number(options.refreshIntervalMs ?? 0));
    this.on("tileloadstart", () => {
      this._pendingTiles++;
      this.#setState("loading");
    });
    this.on("tileload", () => {
      this._pendingTiles = Math.max(0, this._pendingTiles - 1);
      if (this._pendingTiles === 0) this.#setState("ready");
    });
    this.on("tileabort", () => {
      this._pendingTiles = Math.max(0, this._pendingTiles - 1);
      if (this._pendingTiles === 0 && this.state === "loading") this.#setState("idle");
    });
    this.on("tileerror", (event) => {
      this._pendingTiles = Math.max(0, this._pendingTiles - 1);
      this.#setState("error", event);
    });
    this.on("load", () => this.#setState("ready"));
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.container?.classList.add("oh-traffic-layer");
    if (this.container) this.container.style.opacity = String(this.options.opacity);
    this.#startAutoRefresh();
  }

  override onRemove(): void {
    this.#stopAutoRefresh();
    this._pendingTiles = 0;
    this.#setState("idle");
    super.onRemove();
  }

  setDataTime(value: Date | string | number | null): this {
    this.dataTime = value == null ? null : new Date(value);
    this.emit("datatimechange", { dataTime: this.dataTime });
    return this;
  }

  getDataTime(): Date | null {
    return this.dataTime ? new Date(this.dataTime) : null;
  }

  getState(): TrafficState {
    return this.state;
  }

  refresh(dataTime: Date | string | number | null = new Date()): this {
    this.setDataTime(dataTime);
    this.emit("refresh", { dataTime: this.getDataTime() });
    return this.redraw();
  }

  #setState(state: TrafficState, extra: Record<string, unknown> = {}): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("statechange", { state, dataTime: this.getDataTime(), ...extra });
  }

  #startAutoRefresh(): void {
    this.#stopAutoRefresh();
    if (!this.refreshIntervalMs) return;
    this._refreshTimer = setInterval(() => this.refresh(), this.refreshIntervalMs);
  }

  #stopAutoRefresh(): void {
    if (!this._refreshTimer) return;
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }
}

export function trafficLayer(provider: TileTemplate, options?: TrafficLayerOptions): TrafficLayer {
  return new TrafficLayer(provider, options);
}
