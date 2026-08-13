import { createEl, listen } from "./dom.js";
import { EARTH_RADIUS, latLng, type LatLng, type LatLngLike } from "./geo.js";
import type { Layer } from "./layer.js";
import { Orihon, type MapBehaviorName } from "./map.js";
import { GraticuleLayer, graticuleLayer } from "./layers/graticule-layer.js";
import { Polyline, Rectangle, polyline, rectangle, type PathOptions } from "./layers/vector.js";
import { Tooltip, tooltip } from "./overlays/div-overlay.js";
import { Control, type ControlOptions } from "./ui/control.js";
import type { LocaleName } from "./ui/locale.js";

const fullscreenLabels: Record<LocaleName, readonly [enter: string, exit: string]> = {
  en: ["Enter fullscreen", "Exit fullscreen"],
  ru: ["На весь экран", "Выйти из полноэкранного режима"],
  ar: ["ملء الشاشة", "الخروج من ملء الشاشة"],
  tr: ["Tam ekran", "Tam ekrandan çık"],
  zh: ["进入全屏", "退出全屏"],
  de: ["Vollbild", "Vollbild beenden"],
  fr: ["Plein écran", "Quitter le plein écran"],
  da: ["Fuld skærm", "Afslut fuld skærm"],
  hi: ["पूर्ण स्क्रीन", "पूर्ण स्क्रीन से बाहर निकलें"]
};

export interface FullscreenControlOptions extends ControlOptions {
  title?: string;
  exitTitle?: string;
}

export class FullscreenControl extends Control<FullscreenControlOptions> {
  button: HTMLButtonElement | null = null;
  fallbackActive = false;
  private readonly fullscreenChange = (): void => { this.map?.invalidateSize(); this.render(); };

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-fullscreen-control");
    this.button = createEl("button", "oh-control-button", this.el);
    this.button.type = "button";
    this.button.textContent = "⛶";
    this._unsub.push(listen(this.button, "click", () => { void this.toggle(); }));
    this._unsub.push(listen(document, "fullscreenchange", this.fullscreenChange));
    this.render();
  }

  override onRemove(): void {
    if (this.fallbackActive) this.#setFallback(false);
    this.button = null;
    super.onRemove();
  }

  isFullscreen(): boolean {
    return Boolean(this.map && (document.fullscreenElement === this.map.container || this.fallbackActive));
  }

  async toggle(): Promise<void> {
    const map = this.map;
    if (!map) return;
    if (this.isFullscreen()) {
      if (document.fullscreenElement === map.container && document.exitFullscreen) await document.exitFullscreen();
      else this.#setFallback(false);
    } else if (typeof map.container.requestFullscreen === "function") {
      await map.container.requestFullscreen();
    } else {
      this.#setFallback(true);
    }
    map.invalidateSize();
    this.render();
  }

  override render(): void {
    if (!this.button) return;
    const labels = fullscreenLabels[this.locale.language] ?? fullscreenLabels.en;
    const title = this.isFullscreen()
      ? this.options.exitTitle ?? labels[1]
      : this.options.title ?? labels[0];
    this.button.title = title;
    this.button.setAttribute("aria-label", title);
    this.button.setAttribute("aria-pressed", String(this.isFullscreen()));
  }

  #setFallback(active: boolean): void {
    this.fallbackActive = active;
    this.map?.container.classList.toggle("oh-map-expanded", active);
  }
}

export interface MeasureControlOptions extends ControlOptions, PathOptions {
  title?: string;
  units?: "metric" | "imperial" | "map";
  geodesic?: boolean;
}

export class MeasureControl extends Control<MeasureControlOptions> {
  button: HTMLButtonElement | null = null;
  active = false;
  readonly points: LatLng[] = [];
  line: Polyline | null = null;
  tip: Tooltip | null = null;
  private preview: LatLng | null = null;
  private readonly priorBehaviors = new Map<MapBehaviorName, boolean>();
  private readonly keyDown = (event: KeyboardEvent): void => {
    if (!this.active || editableTarget(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.clear();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.finish();
    }
  };
  private readonly mapClick = (event: Record<string, unknown>): void => {
    if (!this.active || !event.latlng) return;
    this.points.push(latLng(event.latlng as LatLngLike));
    this.preview = null;
    this.#update();
    this.map?.emit("measurechange", { points: this.getPoints(), distance: this.getDistance() });
  };

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    this.el.classList.add("oh-measure-control");
    this.button = createEl("button", "oh-control-button", this.el);
    this.button.type = "button";
    this.button.textContent = "↔";
    this.button.title = this.options.title ?? "Measure distance";
    this.button.setAttribute("aria-label", this.button.title);
    this._unsub.push(listen(this.button, "click", () => this.active ? this.finish() : this.start()));
    this._unsub.push(listen(map.container, "pointermove", (event) => {
      if (!this.active || !this.points.length) return;
      const rect = map.container.getBoundingClientRect();
      this.preview = map.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top]);
      this.#update();
    }));
    this._unsub.push(listen(map.container, "dblclick", (event) => {
      if (!this.active) return;
      event.preventDefault();
      event.stopPropagation();
      this.finish();
    }, true));
  }

  override onRemove(): void {
    this.clear();
    this.button = null;
    super.onRemove();
  }

  start(): this {
    if (!this.map || this.active) return this;
    this.clear();
    this.active = true;
    for (const name of ["drag", "dblClick"] as MapBehaviorName[]) {
      this.priorBehaviors.set(name, this.map.behaviors.isEnabled(name));
      this.map.behaviors.disable(name);
    }
    this.map.on("click", this.mapClick);
    document.addEventListener("keydown", this.keyDown);
    this.button?.setAttribute("aria-pressed", "true");
    this.map.container.classList.add("oh-measuring");
    this.map.emit("measurestart", { control: this });
    return this;
  }

  finish(): this {
    if (!this.active) return this;
    const distance = this.getDistance();
    this.#deactivate();
    this.preview = null;
    this.#update();
    this.map?.emit("measureend", { points: this.getPoints(), distance });
    return this;
  }

  clear(): this {
    this.#deactivate();
    if (this.map && this.line && this.map.hasLayer(this.line)) this.map.removeLayer(this.line);
    if (this.map && this.tip && this.map.hasLayer(this.tip)) this.map.removeLayer(this.tip);
    this.line = null;
    this.tip = null;
    this.points.length = 0;
    this.preview = null;
    return this;
  }

  getPoints(): LatLng[] { return this.points.map((point) => point.clone()); }

  getDistance(includePreview = false): number {
    if (!this.map) return 0;
    const values = includePreview && this.preview ? [...this.points, this.preview] : this.points;
    let total = 0;
    for (let index = 1; index < values.length; index++) total += this.#segmentDistance(values[index - 1], values[index]);
    return total;
  }

  #segmentDistance(a: LatLng, b: LatLng): number {
    const map = this.map;
    if (!map || (this.options.geodesic ?? true)) return map?.distance(a, b) ?? 0;
    const first = map.crs.project(a, map.zoom);
    const second = map.crs.project(b, map.zoom);
    const projected = Math.hypot(second.x - first.x, second.y - first.y) / map.crs.scale(map.zoom);
    return map.crs.code === "Simple" ? projected : projected * 2 * Math.PI * EARTH_RADIUS;
  }

  #deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map?.off("click", this.mapClick);
    document.removeEventListener("keydown", this.keyDown);
    for (const [name, enabled] of this.priorBehaviors) this.map?.behaviors.toggle(name, enabled);
    this.priorBehaviors.clear();
    this.map?.container.classList.remove("oh-measuring");
    this.button?.setAttribute("aria-pressed", "false");
  }

  #update(): void {
    const map = this.map;
    if (!map || !this.points.length) return;
    const values = this.preview ? [...this.points, this.preview] : this.points;
    if (!this.line) {
      this.line = polyline(values, {
        stroke: this.options.stroke ?? "#e11d48",
        strokeWidth: this.options.strokeWidth ?? 3,
        dashArray: this.options.dashArray ?? "8 5",
        geodesic: this.options.geodesic ?? true,
        interactive: false
      }).addTo(map);
    } else this.line.setLatLngs(values);
    const position = values.at(-1)!;
    const label = this.#format(this.getDistance(Boolean(this.preview)));
    if (!this.tip) this.tip = tooltip(label, { permanent: true, direction: "top" }).setLatLng(position).openOn(map);
    else this.tip.setContent(label).setLatLng(position);
  }

  #format(value: number): string {
    const units = this.options.units ?? (this.map?.crs.code === "Simple" ? "map" : "metric");
    if (units === "map") return `${Math.round(value * 100) / 100}`;
    if (units === "imperial") {
      const feet = value * 3.280839895;
      return feet >= 5280 ? `${(feet / 5280).toFixed(2)} ${this.locale.miles}` : `${Math.round(feet)} ${this.locale.feet}`;
    }
    return value >= 1000 ? `${(value / 1000).toFixed(2)} ${this.locale.kilometers}` : `${Math.round(value)} ${this.locale.meters}`;
  }
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']");
}

export interface MiniMapControlOptions extends ControlOptions {
  zoomOffset?: number;
  width?: number;
  height?: number;
}

export class MiniMapControl extends Control<MiniMapControlOptions> {
  readonly layer: Layer;
  miniMap: Orihon | null = null;
  viewportBounds: Rectangle | null = null;
  private readonly sync = (): void => this.#sync();

  constructor(layer: Layer, options: MiniMapControlOptions = {}) {
    super({ position: "bottom-right", zoomOffset: -4, width: 150, height: 100, ...options });
    this.layer = layer;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.el) return;
    if (this.layer.map) throw new Error("Mini map layer is already attached to a map");
    this.el.classList.add("oh-mini-map-control");
    const host = createEl("div", "oh-mini-map", this.el);
    host.style.width = `${Math.max(80, Number(this.options.width ?? 150))}px`;
    host.style.height = `${Math.max(60, Number(this.options.height ?? 100))}px`;
    this.miniMap = new Orihon(host, {
      center: map.center,
      zoom: map.zoom + Number(this.options.zoomOffset ?? -4),
      minZoom: map.options.minZoom,
      maxZoom: map.options.maxZoom,
      controls: false,
      keyboard: false,
      locale: map.locale,
      crs: map.crs,
      behaviors: { drag: false, scrollZoom: false, pinchZoom: false, dblClick: false, boxZoom: false }
    });
    this.layer.addTo(this.miniMap);
    this.viewportBounds = rectangle(map.getBounds(), { fill: "none", stroke: "#e11d48", strokeWidth: 2, interactive: false }).addTo(this.miniMap);
    map.on("moveend", this.sync);
    map.on("zoomend", this.sync);
    map.on("localechange", this.sync);
    this._unsub.push(() => map.off("moveend", this.sync));
    this._unsub.push(() => map.off("zoomend", this.sync));
    this._unsub.push(() => map.off("localechange", this.sync));
    this.#sync();
  }

  override onRemove(): void {
    this.miniMap?.destroy();
    this.miniMap = null;
    this.viewportBounds = null;
    super.onRemove();
  }

  #sync(): void {
    if (!this.map || !this.miniMap) return;
    this.miniMap.setLocale(this.map.locale);
    this.miniMap.setView(this.map.center, this.map.zoom + Number(this.options.zoomOffset ?? -4));
    this.viewportBounds?.setBounds(this.map.getBounds());
  }
}

export function fullscreenControl(options?: FullscreenControlOptions): FullscreenControl { return new FullscreenControl(options); }
export function measureControl(options?: MeasureControlOptions): MeasureControl { return new MeasureControl(options); }
export function miniMap(layer: Layer, options?: MiniMapControlOptions): MiniMapControl { return new MiniMapControl(layer, options); }

export { GraticuleLayer, graticuleLayer };
export type { GraticuleLayerOptions } from "./layers/graticule-layer.js";
