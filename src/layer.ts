import { Evented } from "./events.js";
import type { LatLng, LatLngLike, Point } from "./geo.js";
import type { Orihon } from "./map.js";

export interface LayerOptions {
  pane?: string;
  attribution?: string;
}

export type QuerySource = "svg" | "dom" | "canvas" | "webgl" | "cluster" | "object";

export interface QueryHit {
  layer: Layer;
  latlng: LatLng;
  source: QuerySource;
  id?: string | number;
  index?: number;
  feature?: unknown;
}

export interface QueryOptions {
  tolerance?: number;
  layers?: Layer[];
  pane?: string;
  limit?: number;
}

export type ResolvedQueryOptions = Required<QueryOptions>;

/** @internal Writable options view for in-package updates outside the class. */
export function layerOptions<T extends LayerOptions>(layer: Layer<T>): T {
  return layer.options as T;
}

export interface LayerEventMap {
  add: { map: Orihon };
  remove: { map: Orihon };
}

export class Layer<TOptions extends LayerOptions = LayerOptions, TEvents extends object = {}> extends Evented<LayerEventMap & TEvents> {
  map: Orihon | null = null;
  readonly #options: TOptions;

  /**
   * Read-only configuration view — the live options object, not a copy. Assigning a field
   * does not update the DOM or renderer, so use the documented setters (`setOpacity`,
   * `setStyle`, …). `Readonly` is a TypeScript guarantee and disappears at runtime.
   */
  get options(): Readonly<TOptions> {
    return this.#options;
  }

  /** Mutable options bag for subclass setters and in-package lifecycle code. */
  protected get writableOptions(): TOptions {
    return this.#options;
  }

  constructor(options: TOptions = {} as TOptions) {
    super();
    this.#options = options;
  }

  addTo(map: Orihon): this {
    map.addLayer(this);
    return this;
  }

  remove(): this {
    this.map?.removeLayer(this);
    return this;
  }

  onAdd(map: Orihon): void {
    this.map = map;
    if (this.options.attribution) map.addAttribution(this.options.attribution);
  }

  onRemove(): void {
    if (this.options.attribution) this.map?.removeAttribution(this.options.attribution);
    this.map = null;
  }

  getPane(name = this.options.pane): HTMLElement | null {
    return this.map?.getPane(name) ?? null;
  }

  /** Camera frames call `render()` only when this returns true. */
  wantsFrameRender(): boolean {
    return true;
  }

  render(): void {}

  /** Optional renderer-specific hit-test used by map.query(). */
  queryHit?(point: Point, options: ResolvedQueryOptions): QueryHit | QueryHit[] | null;
}
