import { createEl, listen } from "../dom.js";
import type { Layer } from "../layer.js";
import type { Orihon, ControlPosition } from "../map.js";
import { resolveLocale, type OrihonLocale, type LocaleInput } from "./locale.js";

export interface ControlOptions {
  position?: ControlPosition;
  prefix?: string;
  locale?: LocaleInput;
  className?: string;
}

export class Control<TOptions extends ControlOptions = ControlOptions> {
  options: TOptions & { position: ControlPosition };
  map: Orihon | null = null;
  el: HTMLDivElement | null = null;
  locale: OrihonLocale;
  protected _unsub: Array<() => void> = [];

  constructor(options = {} as TOptions) {
    this.options = { position: "top-right", ...options };
    this.locale = resolveLocale(options.locale);
  }

  addTo(map: Orihon): this {
    map.addControl(this);
    return this;
  }

  remove(): this {
    this.map?.removeControl(this);
    return this;
  }

  onAdd(map: Orihon): void {
    this.map = map;
    if (!this.options.locale) this.locale = { ...map.locale };
    const corner = map.controlCorners[this.options.position] ?? map.controlCorners["top-right"];
    this.el = createEl("div", `oh-control ${this.options.className ?? ""}`.trim(), corner);
    const stop = (event: Event): void => event.stopPropagation();
    this._unsub.push(listen(this.el, "pointerdown", stop));
    this._unsub.push(listen(this.el, "dblclick", stop));
    this._unsub.push(listen(this.el, "wheel", stop, { passive: true }));
  }

  onRemove(): void {
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.el?.remove();
    this.el = null;
    this.map = null;
  }

  render(): void {}

  getPosition(): ControlPosition {
    return this.options.position;
  }

  setPosition(position: ControlPosition): this {
    this.options.position = position;
    if (this.map && this.el) {
      const corner = this.map.controlCorners[position] ?? this.map.controlCorners["top-right"];
      corner.appendChild(this.el);
    }
    return this;
  }

  getContainer(): HTMLDivElement | null {
    return this.el;
  }
}

export interface ZoomControlOptions extends ControlOptions {
  zoomInTitle?: string;
  zoomOutTitle?: string;
}

export class ZoomControl extends Control<ZoomControlOptions> {
  zoomInButton: HTMLButtonElement | null = null;
  zoomOutButton: HTMLButtonElement | null = null;

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-zoom-control");
    const zoomIn = createEl("button", "oh-control-button", this.el);
    const zoomOut = createEl("button", "oh-control-button", this.el);
    this.zoomInButton = zoomIn;
    this.zoomOutButton = zoomOut;
    zoomIn.type = zoomOut.type = "button";
    zoomIn.textContent = "+";
    zoomOut.textContent = "-";
    zoomIn.title = this.options.zoomInTitle ?? this.locale.zoomIn;
    zoomOut.title = this.options.zoomOutTitle ?? this.locale.zoomOut;
    zoomIn.setAttribute("aria-label", zoomIn.title);
    zoomOut.setAttribute("aria-label", zoomOut.title);
    this._unsub.push(listen(zoomIn, "click", () => map.setZoom(map.zoom + 1)));
    this._unsub.push(listen(zoomOut, "click", () => map.setZoom(map.zoom - 1)));
    const render = (): void => this.render();
    map.on("zoom", render);
    map.on("zoomend", render);
    this._unsub.push(() => map.off("zoom", render));
    this._unsub.push(() => map.off("zoomend", render));
    this.render();
  }

  override onRemove(): void {
    this.zoomInButton = null;
    this.zoomOutButton = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map) return;
    if (this.zoomInButton) {
      const title = this.options.zoomInTitle ?? this.locale.zoomIn;
      this.zoomInButton.disabled = this.map.zoom >= this.map.options.maxZoom;
      this.zoomInButton.title = title;
      this.zoomInButton.setAttribute("aria-label", title);
    }
    if (this.zoomOutButton) {
      const title = this.options.zoomOutTitle ?? this.locale.zoomOut;
      this.zoomOutButton.disabled = this.map.zoom <= this.map.options.minZoom;
      this.zoomOutButton.title = title;
      this.zoomOutButton.setAttribute("aria-label", title);
    }
  }
}

export interface ScaleControlOptions extends ControlOptions {
  maxWidth?: number;
  units?: "metric" | "imperial" | "both";
}

export class ScaleControl extends Control<ScaleControlOptions> {
  metricLine: HTMLDivElement | null = null;
  imperialLine: HTMLDivElement | null = null;

  constructor(options: ScaleControlOptions = {}) {
    super({ position: "bottom-left", ...options });
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-scale-control");
    this.metricLine = createEl("div", "oh-scale-line", this.el);
    this.imperialLine = createEl("div", "oh-scale-line", this.el);
    this.render();
  }

  override onRemove(): void {
    this.metricLine = null;
    this.imperialLine = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.el) return;
    const a = this.map.containerPointToLatLng({ x: 0, y: this.map.size.height });
    const maxWidth = Math.max(40, Number(this.options.maxWidth ?? 100));
    const b = this.map.containerPointToLatLng({ x: maxWidth, y: this.map.size.height });
    const meters = this.map.distance(a, b);
    const units = this.options.units ?? "metric";
    const metric = formatMetricScale(meters, this.locale);
    const imperial = formatImperialScale(meters, this.locale);
    this.#renderLine(this.metricLine, metric, meters, maxWidth, units !== "imperial");
    this.#renderLine(this.imperialLine, imperial, meters, maxWidth, units !== "metric");
  }

  #renderLine(
    line: HTMLDivElement | null,
    scale: { meters: number; label: string },
    availableMeters: number,
    maxWidth: number,
    visible: boolean
  ): void {
    if (!line) return;
    line.hidden = !visible;
    line.style.width = `${Math.max(40, Math.round((scale.meters / availableMeters) * maxWidth))}px`;
    line.textContent = scale.label;
  }
}

export interface GeolocationControlOptions extends ControlOptions, PositionOptions {
  zoom?: number;
}

export class GeolocationControl extends Control<GeolocationControlOptions> {
  button: HTMLButtonElement | null = null;
  private _active = false;

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this._active = true;
    if (!this.el) return;
    this.el.classList.add("oh-geolocation-control");
    const button = createEl("button", "oh-control-button", this.el);
    this.button = button;
    button.type = "button";
    button.title = this.locale.locate;
    button.setAttribute("aria-label", this.locale.locate);
    button.textContent = "◎";
    this._unsub.push(listen(button, "click", () => {
      if (!navigator.geolocation) {
        const error = new Error(this.locale.locationError);
        map.emit("locationerror", { error });
        return;
      }
      button.disabled = true;
      button.title = this.locale.locating;
      button.setAttribute("aria-label", this.locale.locating);
      this.el?.classList.add("oh-control-loading");
      navigator.geolocation.getCurrentPosition((position) => {
        this.#settle();
        if (!this._active || !this.map) return;
        const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
        this.map.setView(latlng, Math.max(this.map.zoom, Number(this.options.zoom ?? 14)));
        this.map.emit("locationfound", { latlng, accuracy: position.coords.accuracy, position });
      }, (error) => {
        this.#settle();
        if (!this._active || !this.map) return;
        this.map.emit("locationerror", { error });
      }, {
        enableHighAccuracy: this.options.enableHighAccuracy,
        timeout: this.options.timeout,
        maximumAge: this.options.maximumAge
      });
    }));
  }

  override onRemove(): void {
    this._active = false;
    this.button = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.button || this.button.disabled) return;
    this.button.title = this.locale.locate;
    this.button.setAttribute("aria-label", this.locale.locate);
  }

  #settle(): void {
    if (!this.button) return;
    this.button.disabled = false;
    this.button.title = this.locale.locate;
    this.button.setAttribute("aria-label", this.locale.locate);
    this.el?.classList.remove("oh-control-loading");
  }
}

export interface AttributionOptions extends ControlOptions {
  prefix?: string;
}

export class AttributionControl extends Control<AttributionOptions> {
  constructor(options: AttributionOptions = {}) {
    super({ position: "bottom-right", prefix: "Orihon", ...options });
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.el?.classList.add("oh-attribution-control");
    const render = (): void => this.render();
    map.on("attributionchange", render);
    this._unsub.push(() => map.off("attributionchange", render));
    this.render();
  }

  override render(): void {
    if (!this.map || !this.el) return;
    const parts: string[] = [];
    if (this.options.prefix) parts.push(this.options.prefix);
    parts.push(...this.map.getAttributions());
    this.el.textContent = parts.join(" | ");
  }
}

export interface LayersControlOptions extends ControlOptions {
  collapsed?: boolean;
}

interface LayerEntry {
  layer: Layer;
  name: string;
  overlay: boolean;
}

let layersControlId = 0;

export class LayersControl extends Control<LayersControlOptions> {
  readonly entries: LayerEntry[] = [];
  readonly groupName = `oh-layers-${++layersControlId}`;
  form: HTMLDivElement | null = null;
  toggleButton: HTMLButtonElement | null = null;
  expanded: boolean;
  readonly inputUnsub: Array<() => void> = [];

  constructor(
    baseLayers: Record<string, Layer> = {},
    overlays: Record<string, Layer> = {},
    options: LayersControlOptions = {}
  ) {
    super({ position: "top-right", collapsed: true, ...options });
    this.expanded = !(options.collapsed ?? true);
    for (const [name, layer] of Object.entries(baseLayers)) this.addBaseLayer(layer, name);
    for (const [name, layer] of Object.entries(overlays)) this.addOverlay(layer, name);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-layers-control");
    this.toggleButton = createEl("button", "oh-layers-toggle", this.el);
    this.toggleButton.type = "button";
    this.toggleButton.title = this.locale.layers;
    this.toggleButton.setAttribute("aria-label", this.locale.layers);
    this.toggleButton.textContent = "☷";
    this.form = createEl("div", "oh-layers-list", this.el);
    const listId = `${this.groupName}-list`;
    this.form.id = listId;
    this.form.setAttribute("role", "group");
    this.form.setAttribute("aria-label", this.locale.layers);
    this.toggleButton.setAttribute("aria-controls", listId);
    this._unsub.push(listen(this.toggleButton, "click", () => {
      if (this.expanded) this.collapse();
      else this.expand();
    }));
    const render = (): void => this.render();
    map.on("layeradd", render);
    map.on("layerremove", render);
    this._unsub.push(() => map.off("layeradd", render));
    this._unsub.push(() => map.off("layerremove", render));
    this.render();
  }

  override onRemove(): void {
    for (const unsubscribe of this.inputUnsub.splice(0)) unsubscribe();
    this.form = null;
    this.toggleButton = null;
    super.onRemove();
  }

  addBaseLayer(layer: Layer, name: string): this {
    this.entries.push({ layer, name: String(name), overlay: false });
    this.render();
    return this;
  }

  addOverlay(layer: Layer, name: string): this {
    this.entries.push({ layer, name: String(name), overlay: true });
    this.render();
    return this;
  }

  removeLayer(layer: Layer): this {
    const index = this.entries.findIndex((entry) => entry.layer === layer);
    if (index >= 0) this.entries.splice(index, 1);
    this.render();
    return this;
  }

  expand(): this {
    this.expanded = true;
    this.el?.classList.add("oh-layers-expanded");
    if (this.form) this.form.hidden = false;
    return this;
  }

  collapse(): this {
    if (this.options.collapsed === false) return this.expand();
    this.expanded = false;
    this.el?.classList.remove("oh-layers-expanded");
    if (this.form) this.form.hidden = true;
    return this;
  }

  override render(): void {
    if (!this.map || !this.form) return;
    if (this.toggleButton) {
      this.toggleButton.title = this.locale.layers;
      this.toggleButton.setAttribute("aria-label", this.locale.layers);
    }
    this.form.setAttribute("aria-label", this.locale.layers);
    for (const unsubscribe of this.inputUnsub.splice(0)) unsubscribe();
    this.form.textContent = "";
    let hasBase = false;
    for (const entry of this.entries) {
      if (!entry.overlay && !hasBase) {
        hasBase = true;
        const heading = createEl("div", "oh-layers-heading", this.form);
        heading.textContent = this.locale.baseMaps;
      }
      if (entry.overlay && !this.form.querySelector(".oh-layers-overlays")) {
        const heading = createEl("div", "oh-layers-heading oh-layers-overlays", this.form);
        heading.textContent = this.locale.overlays;
      }
      const label = createEl("label", "oh-layers-option", this.form);
      const input = createEl("input", "", label);
      input.type = entry.overlay ? "checkbox" : "radio";
      input.name = entry.overlay ? "" : this.groupName;
      input.checked = this.map.hasLayer(entry.layer);
      const text = createEl("span", "", label);
      text.textContent = entry.name;
      this.inputUnsub.push(listen(input, "change", () => this.#changeLayer(entry, input.checked)));
    }
    this.toggleButton?.setAttribute("aria-expanded", String(this.expanded));
    if (this.form) this.form.hidden = !this.expanded;
    this.el?.classList.toggle("oh-layers-expanded", this.expanded);
  }

  #changeLayer(entry: LayerEntry, enabled: boolean): void {
    if (!this.map) return;
    if (entry.overlay) {
      if (enabled) this.map.addLayer(entry.layer);
      else this.map.removeLayer(entry.layer);
      return;
    }
    if (!enabled) return;
    for (const candidate of this.entries) {
      if (!candidate.overlay && candidate.layer !== entry.layer && this.map.hasLayer(candidate.layer)) {
        this.map.removeLayer(candidate.layer);
      }
    }
    this.map.addLayer(entry.layer);
  }
}

export type CustomControlContent = string | number | Node | ((map: Orihon) => string | number | Node);

export interface CustomControlOptions extends ControlOptions {
  ariaLabel?: string;
  onRemove?: (map: Orihon) => void;
}

export class CustomControl extends Control<CustomControlOptions> {
  private content: CustomControlContent;
  private contentHost: HTMLDivElement | null = null;

  constructor(content: CustomControlContent, options: CustomControlOptions = {}) {
    super(options);
    this.content = content;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-custom-control");
    if (this.options.ariaLabel) this.el.setAttribute("aria-label", this.options.ariaLabel);
    this.contentHost = createEl("div", "oh-custom-control-content", this.el);
    this.#renderContent();
  }

  override onRemove(): void {
    const map = this.map;
    this.contentHost = null;
    super.onRemove();
    if (map) this.options.onRemove?.(map);
  }

  setContent(content: CustomControlContent): this {
    this.content = content;
    this.#renderContent();
    return this;
  }

  getContent(): CustomControlContent {
    return this.content;
  }

  #renderContent(): void {
    if (!this.contentHost || !this.map) return;
    const value = typeof this.content === "function" ? this.content(this.map) : this.content;
    if (typeof Node !== "undefined" && value instanceof Node) this.contentHost.replaceChildren(value);
    else this.contentHost.textContent = String(value);
  }
}

function niceDistance(value: number): number {
  const pow = 10 ** Math.floor(Math.log10(value));
  const scaled = value / pow;
  const nice = scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1;
  return nice * pow;
}

function formatMetricScale(meters: number, locale: OrihonLocale): { meters: number; label: string } {
  const nice = niceDistance(meters);
  return {
    meters: nice,
    label: nice >= 1000 ? `${nice / 1000} ${locale.kilometers}` : `${nice} ${locale.meters}`
  };
}

function formatImperialScale(meters: number, locale: OrihonLocale): { meters: number; label: string } {
  const feetPerMeter = 3.280839895;
  const feet = meters * feetPerMeter;
  if (feet >= 5280) {
    const miles = niceDistance(feet / 5280);
    return { meters: miles * 5280 / feetPerMeter, label: `${miles} ${locale.miles}` };
  }
  const niceFeet = niceDistance(feet);
  return { meters: niceFeet / feetPerMeter, label: `${niceFeet} ${locale.feet}` };
}

export function zoomControl(options?: ZoomControlOptions): ZoomControl { return new ZoomControl(options); }
export function scaleControl(options?: ScaleControlOptions): ScaleControl { return new ScaleControl(options); }
export function geolocationControl(options?: GeolocationControlOptions): GeolocationControl { return new GeolocationControl(options); }
export function attributionControl(options?: AttributionOptions): AttributionControl { return new AttributionControl(options); }
export function layersControl(
  baseLayers?: Record<string, Layer>,
  overlays?: Record<string, Layer>,
  options?: LayersControlOptions
): LayersControl {
  return new LayersControl(baseLayers, overlays, options);
}

export function customControl(content: CustomControlContent, options?: CustomControlOptions): CustomControl {
  return new CustomControl(content, options);
}
