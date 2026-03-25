import { UnsupportedCapabilityError } from "./errors.js";
import { Evented, type OrihonEvent, type EventHandler } from "./events.js";
import { latLng, type LatLng, type LatLngLike, type Point } from "./geo.js";
import type { Orihon } from "./map.js";
import type { OverlayContent, Popup, PopupOptions, Tooltip, TooltipOptions } from "./overlays/div-overlay.js";

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

type PopupFactory = (content: OverlayContent, options?: PopupOptions) => Popup;
type TooltipFactory = (content: OverlayContent, options?: TooltipOptions) => Tooltip;

let createPopup: PopupFactory | null = null;
let createTooltip: TooltipFactory | null = null;

export function registerOverlayFactories(popupFactory: PopupFactory, tooltipFactory: TooltipFactory): void {
  createPopup = popupFactory;
  createTooltip = tooltipFactory;
}

/** @internal Writable options view for in-package updates outside the class. */
export function layerOptions<T extends LayerOptions>(layer: Layer<T>): T {
  return layer.options as T;
}

interface LocatedLayer {
  getLatLng(): LatLngLike;
}

interface BoundedLayer {
  getBounds(): { getCenter(): LatLngLike; isValid?(): boolean };
}

export interface LayerEventMap {
  add: { map: Orihon };
  remove: { map: Orihon };
}

export class Layer<TOptions extends LayerOptions = LayerOptions, TEvents extends object = {}> extends Evented<LayerEventMap & TEvents> {
  map: Orihon | null = null;
  readonly #options: TOptions;

  /**
   * Configuration snapshot. Treat as read-only: assigning fields does not update
   * the DOM or renderer. Use documented setters (`setOpacity`, `setStyle`, …).
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

/**
 * Layer that can carry a Popup and a Tooltip.
 *
 * The overlay implementation lives in `orihon/standard` and above; every entry that exports an
 * `InteractiveLayer` subclass also loads the overlay module, so the binding methods are backed by
 * a real implementation wherever this type is reachable. Core raster layers extend plain `Layer`
 * instead of advertising a capability that tier does not ship.
 */
export class InteractiveLayer<TOptions extends LayerOptions = LayerOptions, TEvents extends object = {}> extends Layer<TOptions, TEvents> {
  protected _popup: Popup | null = null;
  protected _tooltip: Tooltip | null = null;
  private _popupHandlers: Array<[string, EventHandler]> = [];
  private _tooltipHandlers: Array<[string, EventHandler]> = [];

  bindPopup(content: OverlayContent, options?: PopupOptions): this {
    if (!createPopup) throw new UnsupportedCapabilityError("Popup module is not registered: import an entry that ships overlays (orihon/standard or orihon)", { context: { capability: "popup" } });
    this.unbindPopup();
    this._popup = createPopup(content, options);
    const open: EventHandler = (event) => {
      this._popup?.setContentContext({ source: this, event, data: event.data });
      this.openPopup(this._eventLatLng(event));
    };
    const move: EventHandler = (event) => {
      const value = this._eventLatLng(event, false);
      if (value && this._popup?.isOpen()) this._popup.setLatLng(value);
    };
    const close: EventHandler = () => this.closePopup();
    this._popupHandlers = [["click", open], ["drag", move], ["remove", close]];
    for (const [type, handler] of this._popupHandlers) this.on(type, handler);
    return this;
  }

  unbindPopup(): this {
    for (const [type, handler] of this._popupHandlers) this.off(type, handler);
    this._popupHandlers = [];
    this._popup?.close();
    this._popup = null;
    return this;
  }

  openPopup(value?: LatLngLike): this {
    if (!this.map || !this._popup) return this;
    this._popup.setLatLng(value ?? this._overlayAnchor()).openOn(this.map);
    return this;
  }

  closePopup(): this {
    this._popup?.close();
    return this;
  }

  togglePopup(): this {
    return this._popup?.isOpen() ? this.closePopup() : this.openPopup();
  }

  isPopupOpen(): boolean {
    return Boolean(this._popup?.isOpen());
  }

  getPopup(): Popup | null {
    return this._popup;
  }

  bindTooltip(content: OverlayContent, options?: TooltipOptions): this {
    if (!createTooltip) throw new UnsupportedCapabilityError("Tooltip module is not registered: import an entry that ships overlays (orihon/standard or orihon)", { context: { capability: "tooltip" } });
    this.unbindTooltip();
    this._tooltip = createTooltip(content, options);
    const open: EventHandler = (event) => {
      this._tooltip?.setContentContext({ source: this, event, data: event.data });
      this.openTooltip(this._eventLatLng(event));
    };
    const move: EventHandler = (event) => {
      const value = this._eventLatLng(event, false);
      if (!value || !this._tooltip?.isOpen()) return;
      this._tooltip.setContentContext({ source: this, event, data: event.data });
      this._tooltip.setLatLng(value);
    };
    const close: EventHandler = () => {
      if (!this._tooltip?.options.permanent) this.closeTooltip();
    };
    const remove: EventHandler = () => this.closeTooltip();
    const add: EventHandler = () => {
      if (this._tooltip?.options.permanent) this.openTooltip();
    };
    this._tooltipHandlers = [
      ["mouseover", open],
      ["mousemove", move],
      ["mouseout", close],
      ["drag", move],
      ["add", add],
      ["remove", remove]
    ];
    for (const [type, handler] of this._tooltipHandlers) this.on(type, handler);
    if (this.map && this._tooltip.options.permanent) this.openTooltip();
    return this;
  }

  unbindTooltip(): this {
    for (const [type, handler] of this._tooltipHandlers) this.off(type, handler);
    this._tooltipHandlers = [];
    this._tooltip?.close();
    this._tooltip = null;
    return this;
  }

  openTooltip(value?: LatLngLike): this {
    if (!this.map || !this._tooltip) return this;
    this._tooltip.setLatLng(value ?? this._overlayAnchor()).openOn(this.map);
    return this;
  }

  closeTooltip(): this {
    this._tooltip?.close();
    return this;
  }

  isTooltipOpen(): boolean {
    return Boolean(this._tooltip?.isOpen());
  }

  getTooltip(): Tooltip | null {
    return this._tooltip;
  }

  protected _overlayAnchor(): LatLngLike {
    const located = this as unknown as Partial<LocatedLayer>;
    if (typeof located.getLatLng === "function") return located.getLatLng();
    const bounded = this as unknown as Partial<BoundedLayer>;
    if (typeof bounded.getBounds === "function") {
      const value = bounded.getBounds();
      if (!value.isValid || value.isValid()) return value.getCenter();
    }
    if (this.map) return this.map.getCenter();
    throw new Error("Layer has no geographic anchor");
  }

  private _eventLatLng(event: OrihonEvent, fallback = true): LatLngLike | undefined {
    const value = event.latlng;
    if (Array.isArray(value) || (typeof value === "object" && value !== null && "lat" in value && "lng" in value)) {
      return latLng(value as LatLngLike);
    }
    return fallback ? this._overlayAnchor() : undefined;
  }
}
