import { createEl, getContainer, listen, rafThrottle } from "./dom.js";
import type { CameraState } from "./camera.js";
import { mergeOptions, nonNegativeFinite, rejectLegacyUnit, rejectRemovedOption } from "./units.js";
import { CRS, resolveCRS, type CoordinateReferenceSystem, type CRSInput } from "./crs.js";
import { DestroyedError } from "./errors.js";
import { Evented } from "./events.js";
import { LatLng, LatLngBounds, Point, latLng, bounds, point, TILE_SIZE, distance, type LatLngBoundsLike, type LatLngLike, type PointLike } from "./geo.js";
import type { Layer, QueryHit, QueryOptions, ResolvedQueryOptions } from "./layer.js";
import { AttributionControl, ScaleControl, ZoomControl, type Control } from "./ui/control.js";
import { ensureLocalePacks, localePackLoaded, resolveLocale, type OrihonLocale, type LocaleInput } from "./ui/locale.js";
import type { ExportPngOptions, PrintMapOptions } from "./services/map-export.js";
import type { Popup, Tooltip } from "./overlays/div-overlay.js";

export interface MapOptions {
  center?: LatLngLike;
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  zoomSnap?: number;
  wheelZoomStep?: number;
  maxBounds?: LatLngBoundsLike | null;
  maxBoundsViscosity?: number;
  inertia?: boolean;
  inertiaDeceleration?: number;
  inertiaMaxSpeed?: number;
  /** Camera animation duration in milliseconds. Default 250; zero jumps immediately. */
  zoomAnimationDurationMs?: number;
  controls?: boolean;
  locale?: LocaleInput;
  ariaLabel?: string;
  keyboard?: boolean;
  keyboardPanDelta?: number;
  behaviors?: BehaviorOptions;
  crs?: CRSInput;
}

/**
 * Which animation a camera move runs. `"none"` jumps to the target; `"fly"` runs the `flyTo`
 * curve. A name rather than a boolean because the option selects an implementation, and the
 * set can grow without a second flag.
 */
export type CameraAnimation = "none" | "fly";

export interface CameraMotionOptions {
  /** Default `"none"`. */
  animation?: CameraAnimation;
  /** Only meaningful for an animated move; defaults to `zoomAnimationDurationMs`. */
  durationMs?: number;
}

export interface FitBoundsOptions extends CameraMotionOptions {
  /** Screen-space padding in CSS pixels kept around the fitted bounds. Default 32. */
  padding?: number;
}

export interface MapSize {
  width: number;
  height: number;
}

export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type MapBehaviorName = "drag" | "scrollZoom" | "pinchZoom" | "dblClick" | "boxZoom";
export type BehaviorOptions = Partial<Record<MapBehaviorName, boolean>>;

type ResolvedMapOptions = Required<Omit<MapOptions, "behaviors" | "maxBounds" | "crs">> & {
  behaviors: BehaviorOptions;
  maxBounds: LatLngBounds | null;
  crs: CoordinateReferenceSystem;
};

const DEFAULTS: ResolvedMapOptions = {
  center: { lat: 0, lng: 0 },
  zoom: 2,
  minZoom: 0,
  maxZoom: 19,
  zoomSnap: 0.25,
  wheelZoomStep: 0.35,
  maxBounds: null,
  maxBoundsViscosity: 1,
  inertia: true,
  inertiaDeceleration: 3200,
  inertiaMaxSpeed: 1400,
  zoomAnimationDurationMs: 250,
  controls: true,
  locale: "en",
  ariaLabel: "",
  keyboard: true,
  keyboardPanDelta: 80,
  behaviors: {},
  crs: CRS.EPSG3857
};

const DEFAULT_BEHAVIORS: Record<MapBehaviorName, boolean> = {
  drag: true,
  scrollZoom: true,
  pinchZoom: true,
  dblClick: true,
  boxZoom: true
};

interface ViewSession {
  move: boolean;
  zoom: boolean;
}

interface GesturePointer {
  id: number;
  x: number;
  y: number;
}

type Gesture =
  | { type: "drag"; pointerId: number; start: Point; origin: Point; moved: boolean; last: Point; lastTime: number; velocity: Point }
  | { type: "box"; pointerId: number; start: Point; box: HTMLDivElement; moved: boolean }
  | { type: "pinch"; distance: number; zoom: number; anchor: LatLng };

const DEFAULT_PANES = new Set(["tile", "overlay", "marker", "tooltip", "popup", "control"]);

function normalizeMaxBounds(value: LatLngBoundsLike | null | undefined): LatLngBounds | null {
  if (!value) return null;
  const target = bounds(value);
  return target.isValid() ? target : null;
}

export class BehaviorManager {
  readonly map: Orihon;
  readonly #states: Record<MapBehaviorName, boolean>;
  /**
   * Read-only view of every behavior flag. Writing one directly would skip the
   * `behaviorchange` event and the listener wiring, so changes go through
   * `enable` / `disable` / `toggle`; `isEnabled` and `getEnabled` read single values.
   */
  get states(): Readonly<Record<MapBehaviorName, boolean>> { return this.#states; }

  constructor(map: Orihon, options: BehaviorOptions = {}) {
    this.map = map;
    this.#states = { ...DEFAULT_BEHAVIORS, ...options };
  }

  enable(name: MapBehaviorName): this {
    return this.#set(name, true);
  }

  disable(name: MapBehaviorName): this {
    return this.#set(name, false);
  }

  toggle(name: MapBehaviorName, enabled = !this.isEnabled(name)): this {
    return this.#set(name, enabled);
  }

  isEnabled(name: MapBehaviorName): boolean {
    return this.#states[name] !== false;
  }

  getEnabled(): MapBehaviorName[] {
    return (Object.keys(this.#states) as MapBehaviorName[]).filter((name) => this.isEnabled(name));
  }

  #set(name: MapBehaviorName, enabled: boolean): this {
    if (!(name in this.#states)) throw new TypeError(`Unknown map behavior: ${name}`);
    const next = Boolean(enabled);
    if (this.#states[name] === next) return this;
    this.#states[name] = next;
    this.map.emit("behaviorchange", { name, enabled: next, behaviors: this.getEnabled() });
    return this;
  }
}

/** Payloads emitted by the map and its built-in controls. Custom events may augment this interface. */
export interface MapEventMap {
  click: { originalEvent: MouseEvent; containerPoint: Point; latlng: LatLng };
  movestart: { center: LatLng };
  move: { center: LatLng };
  moveend: { center: LatLng };
  zoomstart: { zoom: number };
  zoom: { zoom: number };
  zoomend: { zoom: number };
  resize: { oldSize: Point; newSize: Point };
  boxzoomstart: { containerPoint: Point };
  boxzoomend: { containerPoint: Point; bounds: LatLngBounds };
  behaviorchange: { name: MapBehaviorName; enabled: boolean; behaviors: MapBehaviorName[] };
  localechange: { locale: OrihonLocale };
  layeradd: { layer: Layer };
  layerremove: { layer: Layer };
  attributionchange: { attributions: string[] };
  locationfound: { latlng: LatLngLike; accuracy: number; position: GeolocationPosition };
  locationerror: { error: Error | GeolocationPositionError };
  unload: {};
  popupopen: { popup: Popup };
  popupclose: { popup: Popup };
  tooltipopen: { tooltip: Tooltip };
  tooltipclose: { tooltip: Tooltip };
}

/** Shared "nothing to load" readiness; see `#trackLocale`. */
const SETTLED_LOCALE = Promise.resolve();

export class Orihon extends Evented<MapEventMap> {
  readonly #options: ResolvedMapOptions;
  /**
   * Read-only configuration view, matching `Layer.options`. Assigning a field
   * changes no live state — `controls` would not remove existing controls, `locale` would not
   * re-render them. Use `setLocale`, `setMaxBounds`, `setMinZoom` / `setMaxZoom` and
   * `map.behaviors` instead.
   *
   * `Readonly` is a TypeScript guarantee: this is a read-only view of the live configuration
   * object, not a copy, and the modifier disappears at runtime.
   */
  get options(): Readonly<ResolvedMapOptions> { return this.#options; }
  readonly container: HTMLElement;
  viewport!: HTMLDivElement;
  readonly #panes: Record<string, HTMLElement> = {};
  /** Pane elements by name. Read-only view: create and drop panes with `createPane` / `removePane`. */
  get panes(): Readonly<Record<string, HTMLElement>> { return this.#panes; }
  #controlCorners = {} as Record<ControlPosition, HTMLDivElement>;
  /** Control anchor elements by position. Read-only view: `addControl` places controls for you. */
  get controlCorners(): Readonly<Record<ControlPosition, HTMLDivElement>> { return this.#controlCorners; }
  #center: LatLng;
  #zoom: number;
  #size: MapSize = { width: 0, height: 0 };
  #pixelOrigin = new Point(0, 0);
  #panVelocity = new Point(0, 0);
  /**
   * Live camera. These are views on the state the render loop owns, so they read cheaply from
   * layers every frame but cannot be written: moving the camera without `setView` / `setZoom`
   * would skip clamping, the view session and the render pass. `getCamera()` returns a detached
   * snapshot when a value has to outlive the frame.
   */
  get center(): LatLng { return this.#center; }
  get zoom(): number { return this.#zoom; }
  get size(): Readonly<MapSize> { return this.#size; }
  get pixelOrigin(): Readonly<Point> { return this.#pixelOrigin; }
  /** Screen-space pan velocity in px/s. Updated during drag / inertia; zero when idle. */
  get panVelocity(): Readonly<Point> { return this.#panVelocity; }
  readonly #layers = new Set<Layer>();
  /** Attached layers; iterate with `for (const layer of map.layers)`. Mutation goes through `addLayer` / `removeLayer`. */
  get layers(): ReadonlySet<Layer> { return this.#layers; }
  readonly #controls = new Set<Control>();
  /** Attached controls; iterate with `for (const control of map.controls)`. Mutation goes through `addControl` / `removeControl`. */
  get controls(): ReadonlySet<Control> { return this.#controls; }
  readonly locale: OrihonLocale;
  #localeReady: Promise<void> = Promise.resolve();
  /**
   * Resolves once the locale requested by `options.locale` / `setLocale()` is actually applied.
   * Core loads non-English packs lazily, so `map.locale` starts as English strings tagged with
   * the requested `language`; Standard and Advanced register the packs at import and resolve
   * immediately. Await this before asserting on control or accessibility text. Rejects with the
   * import failure when the pack chunk cannot be loaded — the map keeps working in English.
   */
  get localeReady(): Promise<void> { return this.#localeReady; }
  readonly behaviors: BehaviorManager;
  readonly crs: CoordinateReferenceSystem;
  readonly #attributions = new Map<string, number>();
  readonly #viewSession: ViewSession = { move: false, zoom: false };
  readonly #unsub: Array<() => void> = [];
  readonly #frameRender: () => void;
  #wheelTimer: ReturnType<typeof setTimeout> | null = null;
  #animationFrame: number | null = null;
  #animationActive = false;
  #resizeObserver: ResizeObserver | null = null;
  #destroyed = false;
  readonly #initialA11y: { role: string | null; ariaLabel: string | null; tabIndex: string | null };

  constructor(container: string | HTMLElement, options: MapOptions = {}) {
    super();
    rejectLegacyUnit(options, "zoomAnimationDuration", "zoomAnimationDurationMs");
    nonNegativeFinite(options.zoomAnimationDurationMs ?? DEFAULTS.zoomAnimationDurationMs, "zoomAnimationDurationMs");
    this.#options = {
      ...mergeOptions(DEFAULTS, options),
      maxBounds: normalizeMaxBounds(options.maxBounds),
      crs: resolveCRS(options.crs),
      behaviors: mergeOptions(DEFAULT_BEHAVIORS, options.behaviors)
    };
    this.container = getContainer(container);
    this.locale = resolveLocale(this.#options.locale);
    this.behaviors = new BehaviorManager(this, this.#options.behaviors);
    this.crs = this.#options.crs;
    this.#initialA11y = {
      role: this.container.getAttribute("role"),
      ariaLabel: this.container.getAttribute("aria-label"),
      tabIndex: this.container.getAttribute("tabindex")
    };
    this.#center = latLng(this.#options.center);
    this.#zoom = this.#clampZoom(this.#options.zoom);
    this.#frameRender = rafThrottle(() => this.#render());
    this.#initDom();
    this.#bindInput();
    this.#bindResize();
    this.invalidateSize();
    if (this.#options.controls) {
      new ZoomControl({ locale: this.locale }).addTo(this);
      new ScaleControl({ locale: this.locale }).addTo(this);
      new AttributionControl({ locale: this.locale }).addTo(this);
    }
    this.#trackLocale(this.#options.locale);
    this.#render();
  }

  #initDom(): void {
    this.container.classList.add("oh-map");
    this.container.setAttribute("role", "application");
    this.container.setAttribute("aria-label", this.#options.ariaLabel || this.locale.mapLabel);
    this.container.tabIndex = 0;
    this.viewport = createEl("div", "oh-viewport", this.container);
    this.createPane("tile", this.viewport, "oh-pane oh-tile-pane");
    this.createPane("overlay", this.viewport, "oh-pane oh-overlay-pane");
    this.createPane("marker", this.viewport, "oh-pane oh-marker-pane");
    this.createPane("tooltip", this.viewport, "oh-pane oh-tooltip-pane");
    this.createPane("popup", this.viewport, "oh-pane oh-popup-pane");
    this.createPane("control", this.container, "oh-control-pane");
    this.#controlCorners = {
      "top-left": createEl("div", "oh-control-corner oh-top-left", this.#panes.control),
      "top-right": createEl("div", "oh-control-corner oh-top-right", this.#panes.control),
      "bottom-left": createEl("div", "oh-control-corner oh-bottom-left", this.#panes.control),
      "bottom-right": createEl("div", "oh-control-corner oh-bottom-right", this.#panes.control)
    };
  }

  #bindResize(): void {
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.invalidateSize());
      this.#resizeObserver.observe(this.container);
      return;
    }
    if (typeof window !== "undefined") {
      this.#unsub.push(listen(window, "resize", () => this.invalidateSize(), { passive: true }));
    }
  }

  #bindInput(): void {
    const pointers = new Map<number, GesturePointer>();
    let gesture: Gesture | null = null;
    let suppressClick = false;

    const containerPoint = (clientX: number, clientY: number): Point => {
      const rect = this.container.getBoundingClientRect();
      return new Point(clientX - rect.left, clientY - rect.top);
    };

    const beginDrag = (pointer: GesturePointer): void => {
      this.stop();
      const start = new Point(pointer.x, pointer.y);
      gesture = {
        type: "drag",
        pointerId: pointer.id,
        start,
        origin: this.crs.project(this.#center, this.#zoom),
        moved: false,
        last: start,
        lastTime: performance.now(),
        velocity: new Point(0, 0)
      };
      this.#beginViewSession(false);
      this.container.classList.add("oh-dragging");
    };

    const beginBoxZoom = (event: PointerEvent, start: Point): void => {
      this.stop();
      const box = createEl("div", "oh-box-zoom", this.container);
      gesture = { type: "box", pointerId: event.pointerId, start, box, moved: false };
      this.container.classList.add("oh-box-zooming");
      this.emit("boxzoomstart", { containerPoint: start });
    };

    const beginPinch = (): void => {
      const [a, b] = [...pointers.values()].slice(0, 2);
      if (!a || !b) return;
      const midpoint = containerPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture = {
        type: "pinch",
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom: this.#zoom,
        anchor: this.containerPointToLatLng(midpoint)
      };
      this.#beginViewSession(true);
    };

    this.#unsub.push(listen(this.container, "pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if ((event.target as Element | null)?.closest?.(".oh-control, .oh-marker")) return;
      const interactiveTarget = (event.target as Element | null)?.closest?.(".oh-interactive");
      // Do not capture a short press on an interactive layer: Chrome retargets
      // pointerup/click to the capture owner, which makes vector bindPopup()
      // unreliable. Capture is acquired below once the gesture becomes a pan.
      if (!interactiveTarget) {
        event.preventDefault();
        this.container.setPointerCapture?.(event.pointerId);
      }
      const pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, pointer);
      if (event.shiftKey && this.behaviors.isEnabled("boxZoom")) {
        beginBoxZoom(event, containerPoint(event.clientX, event.clientY));
        return;
      }
      if (pointers.size === 1 && this.behaviors.isEnabled("drag")) beginDrag(pointer);
      else if (pointers.size === 2 && this.behaviors.isEnabled("pinchZoom")) beginPinch();
    }));

    this.#unsub.push(listen(this.container, "pointermove", (event) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer || !gesture) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (gesture.type === "box" && gesture.pointerId === event.pointerId) {
        const current = containerPoint(event.clientX, event.clientY);
        const left = Math.min(gesture.start.x, current.x);
        const top = Math.min(gesture.start.y, current.y);
        const width = Math.abs(current.x - gesture.start.x);
        const height = Math.abs(current.y - gesture.start.y);
        gesture.moved = width > 6 || height > 6;
        gesture.box.style.left = `${left}px`;
        gesture.box.style.top = `${top}px`;
        gesture.box.style.width = `${width}px`;
        gesture.box.style.height = `${height}px`;
        return;
      }

      if (gesture.type === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()].slice(0, 2);
        if (!a || !b) return;
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const midpoint = containerPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        const nextZoom = this.#clampZoom(gesture.zoom + Math.log2(distance / gesture.distance));
        const projectedAnchor = this.crs.project(gesture.anchor, nextZoom);
        const nextCenter = this.crs.unproject({
          x: projectedAnchor.x - midpoint.x + this.#size.width / 2,
          y: projectedAnchor.y - midpoint.y + this.#size.height / 2
        }, nextZoom);
        this.#applyView(nextCenter, nextZoom);
        return;
      }

      if (gesture.type === "drag" && gesture.pointerId === event.pointerId) {
        const now = performance.now();
        const current = new Point(event.clientX, event.clientY);
        const elapsed = Math.max(1, now - gesture.lastTime);
        gesture.velocity = current.subtract(gesture.last).divideBy(elapsed / 1000);
        this.#panVelocity.x = gesture.velocity.x;
        this.#panVelocity.y = gesture.velocity.y;
        gesture.last = current;
        gesture.lastTime = now;
        const dx = event.clientX - gesture.start.x;
        const dy = event.clientY - gesture.start.y;
        if (Math.hypot(dx, dy) > 3) {
          if (!gesture.moved) this.container.setPointerCapture?.(event.pointerId);
          gesture.moved = true;
          event.preventDefault();
        }
        const nextCenter = this.crs.unproject({ x: gesture.origin.x - dx, y: gesture.origin.y - dy }, this.#zoom);
        this.#applyView(nextCenter, this.#zoom);
      }
    }));

    const stopPointer = (event: PointerEvent): void => {
      if (!pointers.has(event.pointerId)) return;
      const wasPinch = gesture?.type === "pinch";
      const dragVelocity = gesture?.type === "drag" && gesture.moved ? gesture.velocity : null;
      if (gesture?.type === "drag" && gesture.moved) suppressClick = true;
      if (gesture?.type === "box" && gesture.pointerId === event.pointerId) {
        const current = containerPoint(event.clientX, event.clientY);
        const start = gesture.start;
        const moved = gesture.moved;
        gesture.box.remove();
        this.container.classList.remove("oh-box-zooming");
        this.emit("boxzoomend", {
          containerPoint: current,
          bounds: bounds(
            this.containerPointToLatLng([Math.min(start.x, current.x), Math.max(start.y, current.y)]),
            this.containerPointToLatLng([Math.max(start.x, current.x), Math.min(start.y, current.y)])
          )
        });
        pointers.delete(event.pointerId);
        this.container.releasePointerCapture?.(event.pointerId);
        gesture = null;
        if (moved) {
          suppressClick = true;
          this.#zoomToContainerBox(start, current);
          return;
        }
      }
      pointers.delete(event.pointerId);
      this.container.releasePointerCapture?.(event.pointerId);

      if (wasPinch) this.#endViewSession(true, false);
      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0];
        if (remaining && this.behaviors.isEnabled("drag")) beginDrag(remaining);
        return;
      }
      if (pointers.size >= 2) {
        if (this.behaviors.isEnabled("pinchZoom")) beginPinch();
        return;
      }

      gesture = null;
      this.container.classList.remove("oh-dragging");
      this.#endViewSession(false, true);
      if (dragVelocity && this.#options.inertia) this.#startInertia(dragVelocity);
    };
    this.#unsub.push(listen(this.container, "pointerup", stopPointer));
    this.#unsub.push(listen(this.container, "pointercancel", stopPointer));

    this.#unsub.push(listen(this.container, "wheel", (event) => {
      if (!this.behaviors.isEnabled("scrollZoom")) return;
      event.preventDefault();
      if (pointers.size) return;
      const anchor = containerPoint(event.clientX, event.clientY);
      const next = this.#zoom - Math.sign(event.deltaY) * this.#options.wheelZoomStep;
      if (this.#clampZoom(next) === this.#zoom) return;
      this.#beginViewSession(true);
      this.#applyZoomAround(anchor, next);
      if (this.#wheelTimer) clearTimeout(this.#wheelTimer);
      this.#wheelTimer = setTimeout(() => this.#endViewSession(true, true), 140);
    }, { passive: false }));

    this.#unsub.push(listen(this.container, "dblclick", (event) => {
      if (!this.behaviors.isEnabled("dblClick")) return;
      event.preventDefault();
      this.setZoomAround(containerPoint(event.clientX, event.clientY), this.#zoom + 1);
    }));

    this.#unsub.push(listen(this.container, "click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if ((event.target as Element | null)?.closest?.(".oh-control, .oh-marker, .oh-popup, .oh-tooltip")) return;
      const source = containerPoint(event.clientX, event.clientY);
      this.emit("click", {
        originalEvent: event,
        containerPoint: source,
        latlng: this.containerPointToLatLng(source)
      });
    }));

    this.#unsub.push(listen(this.container, "keydown", (event) => {
      if (!this.#options.keyboard || event.target !== this.container) return;
      const delta = this.#options.keyboardPanDelta;
      const panOffsets: Record<string, [number, number]> = {
        ArrowLeft: [-delta, 0],
        ArrowRight: [delta, 0],
        ArrowUp: [0, -delta],
        ArrowDown: [0, delta]
      };
      const panOffset = panOffsets[event.key];
      if (panOffset) {
        event.preventDefault();
        this.panBy(panOffset);
        return;
      }
      if (event.key === "+" || event.key === "=" || event.key === "PageUp") {
        event.preventDefault();
        this.setZoom(this.#zoom + 1);
      } else if (event.key === "-" || event.key === "_" || event.key === "PageDown") {
        event.preventDefault();
        this.setZoom(this.#zoom - 1);
      }
    }));
  }

  #clampZoom(zoom: number): number {
    const snap = Number(this.#options.zoomSnap);
    const numericZoom = Number(zoom);
    const snapped = snap > 0 ? Math.round(numericZoom / snap) * snap : numericZoom;
    return Math.max(this.#options.minZoom, Math.min(this.#options.maxZoom, snapped));
  }

  #pixelOriginFor(center = this.#center, zoom = this.#zoom): Point {
    const centerPoint = this.crs.project(center, zoom);
    return new Point(centerPoint.x - this.#size.width / 2, centerPoint.y - this.#size.height / 2);
  }

  /**
   * Immutable snapshot of the live camera used by geographic renderers.
   * All panes must project through this state within a single paint frame.
   */
  getCamera(): CameraState {
    return {
      center: this.#center.clone(),
      zoom: this.#zoom,
      pixelOrigin: this.#pixelOrigin.clone(),
      size: { width: this.#size.width, height: this.#size.height }
    };
  }

  #limitCenter(center: LatLng, zoom: number): LatLng {
    const maxBounds = this.#options.maxBounds;
    if (!maxBounds || this.#options.maxBoundsViscosity <= 0 || !maxBounds.isValid()) return center;
    if (this.#size.width <= 0 || this.#size.height <= 0) return center;
    const northWest = this.crs.project(maxBounds.getNorthWest(), zoom);
    const southEast = this.crs.project(maxBounds.getSouthEast(), zoom);
    const projected = this.crs.project(center, zoom);
    const minX = Math.min(northWest.x, southEast.x) + this.#size.width / 2;
    const maxX = Math.max(northWest.x, southEast.x) - this.#size.width / 2;
    const minY = Math.min(northWest.y, southEast.y) + this.#size.height / 2;
    const maxY = Math.max(northWest.y, southEast.y) - this.#size.height / 2;
    const clamp = (value: number, min: number, max: number): number => {
      if (min > max) return (min + max) / 2;
      return Math.max(min, Math.min(max, value));
    };
    return this.crs.unproject({
      x: clamp(projected.x, minX, maxX),
      y: clamp(projected.y, minY, maxY)
    }, zoom);
  }

  #cancelAnimation(): void {
    if (this.#animationFrame !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.#animationFrame);
    this.#animationFrame = null;
    this.#animationActive = false;
  }

  #scheduleAnimation(callback: FrameRequestCallback): void {
    if (typeof requestAnimationFrame !== "undefined") this.#animationFrame = requestAnimationFrame(callback);
    else this.#animationFrame = setTimeout(() => callback(performance.now()), 16) as unknown as number;
  }

  #animateView(center: LatLngLike, zoom: number, durationMs = this.#options.zoomAnimationDurationMs): this {
    const targetCenter = this.#limitCenter(latLng(center), this.#clampZoom(zoom));
    const targetZoom = this.#clampZoom(zoom);
    const startCenter = this.#center.clone();
    const startZoom = this.#zoom;
    const zoomChanged = targetZoom !== startZoom;
    const duration = nonNegativeFinite(durationMs, "durationMs");
    this.stop();
    if (duration === 0) return this.setView(targetCenter, targetZoom);
    this.#animationActive = true;
    this.#beginViewSession(zoomChanged);
    const startTime = performance.now();
    const ease = (t: number): number => 1 - (1 - t) ** 3;
    const frame = (now: number): void => {
      if (!this.#animationActive || this.#destroyed) return;
      // rAF hands back the frame's start time, which can predate `startTime`
      // when the animation was kicked off from inside an already-running frame.
      const progress = Math.min(1, Math.max(0, (now - startTime) / duration));
      const eased = ease(progress);
      this.#applyView({ lat: startCenter.lat + (targetCenter.lat - startCenter.lat) * eased, lng: startCenter.lng + (targetCenter.lng - startCenter.lng) * eased }, startZoom + (targetZoom - startZoom) * eased);
      if (progress < 1) {
        this.#scheduleAnimation(frame);
        return;
      }
      this.#animationFrame = null;
      this.#animationActive = false;
      this.#endViewSession(zoomChanged, true);
    };
    this.#scheduleAnimation(frame);
    return this;
  }

  #startInertia(velocity: Point): void {
    const speed = Math.min(this.#options.inertiaMaxSpeed, Math.hypot(velocity.x, velocity.y));
    if (speed < 80) return;
    const direction = velocity.divideBy(Math.max(1, Math.hypot(velocity.x, velocity.y)));
    const duration = speed / Math.max(1, this.#options.inertiaDeceleration);
    const travel = direction.multiplyBy((speed * duration) / 2);
    const origin = this.crs.project(this.#center, this.#zoom);
    const startTime = performance.now();
    this.stop();
    this.#animationActive = true;
    this.#beginViewSession(false);
    const frame = (now: number): void => {
      if (!this.#animationActive || this.#destroyed) return;
      const progress = Math.min(1, Math.max(0, (now - startTime) / (duration * 1000)));
      const eased = 1 - (1 - progress) ** 2;
      const remain = 1 - progress;
      this.#panVelocity.x = direction.x * speed * remain;
      this.#panVelocity.y = direction.y * speed * remain;
      this.#applyView(this.crs.unproject(origin.subtract(travel.multiplyBy(eased)), this.#zoom), this.#zoom);
      if (progress < 1) {
        this.#scheduleAnimation(frame);
        return;
      }
      this.#panVelocity.x = 0;
      this.#panVelocity.y = 0;
      this.#animationFrame = null;
      this.#animationActive = false;
      this.#endViewSession(false, true);
    };
    this.#scheduleAnimation(frame);
  }

  #zoomToContainerBox(start: Point, end: Point): this {
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < 8 || height < 8) return this;
    const centerPoint = start.add(end).divideBy(2);
    const scale = Math.min(this.#size.width / Math.max(1, width), this.#size.height / Math.max(1, height));
    const nextZoom = this.#clampZoom(this.#zoom + Math.log2(Math.max(1, scale)));
    return this.setView(this.containerPointToLatLng(centerPoint), nextZoom);
  }

  #beginViewSession(withZoom: boolean): void {
    if (!this.#viewSession.move) {
      this.#viewSession.move = true;
      this.emit("movestart", { center: this.#center });
    }
    if (withZoom && !this.#viewSession.zoom) {
      this.#viewSession.zoom = true;
      this.emit("zoomstart", { zoom: this.#zoom });
    }
  }

  #endViewSession(withZoom: boolean, withMove: boolean): void {
    if (withZoom && this.#viewSession.zoom) {
      this.#viewSession.zoom = false;
      this.emit("zoomend", { zoom: this.#zoom });
    }
    if (withMove && this.#viewSession.move) {
      this.#viewSession.move = false;
      if (!this.#animationActive) {
        this.#panVelocity.x = 0;
        this.#panVelocity.y = 0;
      }
      this.emit("moveend", { center: this.#center });
    }
  }

  #applyView(center: LatLngLike, zoom: number, syncRender = false): boolean {
    if (this.#destroyed) return false;
    const nextZoom = this.#clampZoom(zoom);
    const nextCenter = this.#limitCenter(latLng(center), nextZoom);
    const zoomChanged = nextZoom !== this.#zoom;
    const centerChanged = !nextCenter.equals(this.#center, 0);
    if (!zoomChanged && !centerChanged) return false;
    this.#center = nextCenter;
    this.#zoom = nextZoom;
    this.#pixelOrigin = this.#pixelOriginFor();
    if (zoomChanged) this.emit("zoom", { zoom: this.#zoom });
    this.emit("move", { center: this.#center });
    if (syncRender) this.#render();
    else this.#frameRender();
    return true;
  }

  #applyZoomAround(anchor: PointLike, zoom: number): boolean {
    const anchorPoint = point(anchor);
    const nextZoom = this.#clampZoom(zoom);
    if (nextZoom === this.#zoom) return false;
    const before = this.containerPointToLatLng(anchorPoint);
    const afterPoint = this.crs.project(before, nextZoom);
    const nextCenter = this.crs.unproject({
      x: afterPoint.x - anchorPoint.x + this.#size.width / 2,
      y: afterPoint.y - anchorPoint.y + this.#size.height / 2
    }, nextZoom);
    return this.#applyView(nextCenter, nextZoom);
  }

  #render(): void {
    if (this.#destroyed) return;
    // Single camera snapshot for this frame — every wantsFrameRender layer reads these fields.
    this.#pixelOrigin = this.#pixelOriginFor();
    for (const layer of this.#layers) {
      if (layer.wantsFrameRender()) layer.render();
    }
    for (const control of this.#controls) control.render();
  }

  /**
   * `destroy()` is terminal and idempotent. Afterwards camera and query methods are inert
   * (they return `this` / `null`), while anything that would attach to the map fails fast with
   * a `DestroyedError` (`code === "ERR_DESTROYED"`). Guard with `isDestroyed` when a map
   * reference may outlive the map. This method and `addLayer` / `addControl` / `createPane`
   * are the throwing side.
   */
  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new DestroyedError("Orihon map was destroyed", { context: { resource: "Orihon" } });
  }

  createPane(name: string, container: HTMLElement = this.viewport, className = `oh-pane oh-${name}-pane`): HTMLElement {
    this.#assertAlive();
    if (!name) throw new TypeError("Pane name is required");
    const existing = this.#panes[name];
    if (existing) return existing;
    const pane = createEl("div", className, container);
    this.#panes[name] = pane;
    return pane;
  }

  getPane(name = "overlay"): HTMLElement | null {
    return this.#panes[name] ?? null;
  }

  getPanes(): Readonly<Record<string, HTMLElement>> {
    return this.#panes;
  }

  removePane(name: string): this {
    if (DEFAULT_PANES.has(name)) return this;
    const pane = this.#panes[name];
    if (!pane) return this;
    pane.remove();
    delete this.#panes[name];
    return this;
  }

  invalidateSize(): this {
    if (this.#destroyed) return this;
    const previous = this.#size;
    const rect = this.container.getBoundingClientRect();
    const next = {
      width: rect.width || this.container.clientWidth,
      height: rect.height || this.container.clientHeight
    };
    this.#size = next;
    if (previous.width > 0 && previous.height > 0 && (previous.width !== next.width || previous.height !== next.height)) {
      this.emit("resize", { oldSize: new Point(previous.width, previous.height), newSize: new Point(next.width, next.height) });
    }
    // Container resizing must re-anchor panes before the browser paints the new layout.
    this.#render();
    return this;
  }

  getContainer(): HTMLElement { return this.container; }
  getCenter(): LatLng { return this.#center.clone(); }
  getZoom(): number { return this.#zoom; }
  getSize(): Point { return new Point(this.#size.width, this.#size.height); }
  getMaxBounds(): LatLngBounds | null { return this.#options.maxBounds ? new LatLngBounds(this.#options.maxBounds) : null; }

  distance(a: LatLngLike, b: LatLngLike): number {
    if (this.crs.code !== "Simple") return distance(a, b);
    const first = latLng(a);
    const second = latLng(b);
    return Math.hypot(second.lng - first.lng, second.lat - first.lat);
  }

  setLocale(input: LocaleInput): this {
    this.#applyLocale(input);
    this.#trackLocale(input);
    return this;
  }

  #applyLocale(input: LocaleInput): void {
    Object.assign(this.locale, resolveLocale(input));
    if (!this.#options.ariaLabel) {
      this.container.setAttribute("aria-label", this.locale.mapLabel);
    }
    for (const control of this.#controls) {
      Object.assign(control.locale, this.locale);
      control.render();
    }
    this.emit("localechange", { locale: this.locale });
  }

  /**
   * Publishes one readiness contract for both entry points: `localeReady` settles as soon as
   * the requested strings are in place, whether the pack was registered at import (Standard,
   * Advanced) or still has to be fetched (Core).
   */
  #trackLocale(input: LocaleInput): void {
    if (typeof input !== "string" || input === "en" || localePackLoaded(input)) {
      // The requested strings are already in place, so readiness is settled and nothing can
      // reject. One shared promise avoids queueing a microtask per map: attaching a handler to
      // a resolved promise schedules a job whose closure keeps the map reachable until the
      // queue drains, which turned map construction into a measurable heap cost.
      this.#localeReady = SETTLED_LOCALE;
      return;
    }
    const pending = ensureLocalePacks().then(() => {
      if (!this.#destroyed) this.#applyLocale(input);
    });
    // A missing translation is not fatal for the map, so the stored promise is always handled.
    // Callers that do care still see the rejection through `await map.localeReady`.
    pending.catch(() => {});
    this.#localeReady = pending;
  }

  addLayer(layer: Layer): this {
    this.#assertAlive();
    if (this.#layers.has(layer)) return this;
    this.#layers.add(layer);
    try {
      layer.onAdd(this);
      layer.render();
    } catch (error) {
      this.#layers.delete(layer);
      if (layer.map === this) layer.onRemove();
      throw error;
    }
    layer.emit("add", { map: this }, false);
    this.emit("layeradd", { layer });
    return this;
  }

  removeLayer(layer: Layer): this {
    if (!this.#layers.delete(layer)) return this;
    layer.onRemove();
    layer.emit("remove", { map: this }, false);
    this.emit("layerremove", { layer });
    return this;
  }

  hasLayer(layer: Layer): boolean {
    return this.#layers.has(layer);
  }

  /** Visit a snapshot of attached layers. Prefer `for (const layer of map.layers)` in new code. */
  eachLayer(callback: (layer: Layer) => void): this {
    for (const layer of [...this.#layers]) callback(layer);
    return this;
  }

  query(containerPoint: PointLike, options: QueryOptions = {}): QueryHit[] {
    const target = point(containerPoint);
    // Reads the public `layers` view rather than the private field: hit testing
    // depends only on the attached layers and the pane order, nothing else.
    const candidates = options.layers ? [...options.layers] : [...this.layers];
    const normalized: ResolvedQueryOptions = {
      tolerance: Math.max(0, Number(options.tolerance ?? 8)),
      layers: candidates,
      pane: options.pane ?? "",
      limit: options.limit === Infinity ? Infinity : Math.max(0, Math.floor(Number(options.limit ?? 1)))
    };
    if (normalized.limit === 0) return [];

    const paneOrder = new Map<Element, number>();
    Array.from(this.viewport.children).forEach((pane, index) => paneOrder.set(pane, index));
    const layerOrder = new Map(candidates.map((layer, index) => [layer, index]));
    candidates.sort((a, b) => {
      const aPane = a.getPane();
      const bPane = b.getPane();
      const ap = aPane ? paneOrder.get(aPane) ?? -1 : -1;
      const bp = bPane ? paneOrder.get(bPane) ?? -1 : -1;
      return ap === bp ? layerOrder.get(a)! - layerOrder.get(b)! : ap - bp;
    });

    const hits: QueryHit[] = [];
    for (let index = candidates.length - 1; index >= 0 && hits.length < normalized.limit; index--) {
      const layer = candidates[index];
      if (normalized.pane && (layer.options.pane ?? "overlay") !== normalized.pane) continue;
      const result = layer.queryHit?.(target, normalized);
      if (!result) continue;
      for (const hit of Array.isArray(result) ? result : [result]) {
        hits.push(hit);
        if (hits.length >= normalized.limit) break;
      }
    }
    return hits;
  }

  queryLatLng(value: LatLngLike, options?: QueryOptions): QueryHit[] {
    return this.query(this.latLngToContainerPoint(value), options);
  }

  async exportPng(options?: ExportPngOptions): Promise<Blob> {
    const { exportMapPng } = await import("./services/map-export.js");
    return exportMapPng(this, options);
  }

  async print(options?: PrintMapOptions): Promise<void> {
    const { printMap } = await import("./services/map-export.js");
    return printMap(this, options);
  }

  addControl(control: Control): this {
    this.#assertAlive();
    if (this.#controls.has(control)) return this;
    this.#controls.add(control);
    try {
      control.onAdd(this);
      control.render();
    } catch (error) {
      this.#controls.delete(control);
      if (control.map === this) control.onRemove();
      throw error;
    }
    return this;
  }

  removeControl(control: Control): this {
    if (!this.#controls.delete(control)) return this;
    control.onRemove();
    return this;
  }

  addAttribution(value: string): this {
    const text = String(value || "").trim();
    if (!text) return this;
    this.#attributions.set(text, (this.#attributions.get(text) || 0) + 1);
    this.emit("attributionchange", { attributions: this.getAttributions() });
    return this;
  }

  removeAttribution(value: string): this {
    const text = String(value || "").trim();
    const count = this.#attributions.get(text);
    if (!count) return this;
    if (count === 1) this.#attributions.delete(text);
    else this.#attributions.set(text, count - 1);
    this.emit("attributionchange", { attributions: this.getAttributions() });
    return this;
  }

  getAttributions(): string[] {
    return [...this.#attributions.keys()];
  }

  setMaxBounds(value: LatLngBoundsLike | null): this {
    this.#options.maxBounds = normalizeMaxBounds(value);
    if (this.#options.maxBounds) this.panInsideBounds(this.#options.maxBounds);
    return this;
  }

  /**
   * Narrow or widen the zoom range at runtime. The current zoom is re-clamped immediately, so
   * raising `minZoom` above the live zoom zooms in rather than leaving the map outside its own
   * limits until the next interaction.
   */
  setMinZoom(zoom: number): this {
    return this.#setZoomLimit("minZoom", zoom);
  }

  setMaxZoom(zoom: number): this {
    return this.#setZoomLimit("maxZoom", zoom);
  }

  #setZoomLimit(name: "minZoom" | "maxZoom", zoom: number): this {
    if (!Number.isFinite(zoom)) throw new TypeError(`Orihon ${name} must be a finite number`);
    const min = name === "minZoom" ? zoom : this.#options.minZoom;
    const max = name === "maxZoom" ? zoom : this.#options.maxZoom;
    if (min > max) throw new RangeError(`Orihon minZoom (${min}) must not exceed maxZoom (${max})`);
    if (this.#options[name] === zoom) return this;
    this.#options[name] = zoom;
    return this.setView(this.#center, this.#zoom);
  }

  panInsideBounds(value: LatLngBoundsLike, options: CameraMotionOptions = {}): this {
    const fly = this.#cameraAnimation(options);
    const target = bounds(value);
    if (!target.isValid()) return this;
    const view = this.getBounds();
    if (target.contains(view)) return this;
    const nextCenter = this.#limitCenter(this.#center, this.#zoom);
    return fly ? this.flyTo(nextCenter, this.#zoom, options) : this.setView(nextCenter, this.#zoom);
  }

  /** Shared validation for every camera move that can be animated. */
  #cameraAnimation(options: CameraMotionOptions): boolean {
    rejectLegacyUnit(options, "duration", "durationMs");
    rejectRemovedOption(options, "animate", `animation: "fly"`);
    if (options.durationMs !== undefined) nonNegativeFinite(options.durationMs, "durationMs");
    const animation = options.animation ?? "none";
    if (animation !== "none" && animation !== "fly") {
      throw new TypeError(`Unknown camera animation: ${String(animation)}. Use "none" or "fly".`);
    }
    return animation === "fly";
  }

  /**
   * Move the camera and finish: the move is terminal, so `moveend` / `zoomend` fire and any
   * running `flyTo` or inertia is cancelled. Use `updateView` for one step of an ongoing motion.
   */
  setView(center: LatLngLike, zoom = this.#zoom): this {
    return this.#setView(center, zoom, true);
  }

  /**
   * One step of a continuous motion — follow-cam, an animation frame, a live position feed.
   * The camera moves but the gesture stays open: `movestart` / `zoomstart` fire once, no
   * `moveend` follows, tiles keep CSS-translating instead of reloading per step, and a running
   * animation is left alone. Finish with `setView` (or let the next gesture end it), otherwise
   * consumers waiting on `moveend` never hear that the motion stopped.
   */
  updateView(center: LatLngLike, zoom = this.#zoom): this {
    return this.#setView(center, zoom, false);
  }

  #setView(center: LatLngLike, zoom: number, settle: boolean): this {
    if (this.#destroyed) return this;
    const nextCenter = latLng(center);
    const nextZoom = this.#clampZoom(zoom);
    const zoomChanged = nextZoom !== this.#zoom;
    const centerChanged = !nextCenter.equals(this.#center, 0);
    // A no-op setView must not cancel a running flyTo / inertia: React effects
    // re-run on every parent render and would otherwise kill camera animation.
    if (!zoomChanged && !centerChanged) {
      if (settle && !this.#animationActive) this.#endViewSession(false, true);
      return this;
    }
    if (settle) this.stop();
    this.#beginViewSession(zoomChanged);
    // Settled jumps paint this frame; live follow pans coalesce on rAF.
    this.#applyView(nextCenter, nextZoom, settle);
    if (settle) this.#endViewSession(zoomChanged, true);
    return this;
  }

  panTo(center: LatLngLike): this { return this.setView(center, this.#zoom); }
  panBy(offset: PointLike): this {
    const nextCenter = this.crs.unproject(this.crs.project(this.#center, this.#zoom).add(point(offset)), this.#zoom);
    return this.panTo(nextCenter);
  }
  setZoom(zoom: number): this { return this.setView(this.#center, zoom); }
  zoomIn(delta = 1): this { return this.setZoom(this.#zoom + delta); }
  zoomOut(delta = 1): this { return this.setZoom(this.#zoom - delta); }

  setZoomAround(anchor: PointLike, zoom: number): this {
    this.stop();
    if (this.#clampZoom(zoom) === this.#zoom) return this;
    this.#beginViewSession(true);
    this.#applyZoomAround(anchor, zoom);
    this.#endViewSession(true, true);
    return this;
  }

  fitBounds(value: LatLngBoundsLike, options: FitBoundsOptions = {}): this {
    const fly = this.#cameraAnimation(options);
    const target = bounds(value);
    const zoom = this.#zoomForBounds(target, options.padding ?? 32);
    return fly ? this.flyTo(target.getCenter(), zoom, options) : this.setView(target.getCenter(), zoom);
  }

  fitWorld(options: FitBoundsOptions = {}): this {
    return this.fitBounds(this.crs.code === "Simple"
      ? this.#options.maxBounds ?? [{ lat: 0, lng: 0 }, { lat: TILE_SIZE, lng: TILE_SIZE }]
      : [{ lat: -85.0511287798066, lng: -180 }, { lat: 85.0511287798066, lng: 180 }], options);
  }

  flyTo(center: LatLngLike, zoom = this.#zoom, options: { durationMs?: number } = {}): this {
    rejectLegacyUnit(options, "duration", "durationMs");
    return this.#animateView(center, zoom, options.durationMs ?? this.#options.zoomAnimationDurationMs);
  }

  flyToBounds(value: LatLngBoundsLike, options: { padding?: number; durationMs?: number } = {}): this {
    const target = bounds(value);
    const zoom = this.#zoomForBounds(target, options.padding ?? 32);
    return this.flyTo(target.getCenter(), zoom, options);
  }

  /** True while a `flyTo` / `panTo` animation or inertia is driving the camera. Pairs with `stop()`. */
  get isAnimating(): boolean {
    return this.#animationActive;
  }

  stop(): this {
    if (!this.#animationActive && this.#animationFrame === null) return this;
    this.#cancelAnimation();
    this.#endViewSession(true, true);
    return this;
  }

  latLngToLayerPoint(value: LatLngLike): Point {
    return this.crs.project(value, this.#zoom).subtract(this.#pixelOrigin);
  }

  latLngToContainerPoint(value: LatLngLike): Point {
    return this.crs.project(value, this.#zoom).subtract(this.#pixelOrigin);
  }

  containerPointToLatLng(value: PointLike): LatLng {
    const source = point(value);
    return this.crs.unproject(source.add(this.#pixelOrigin), this.#zoom);
  }

  getBounds(): LatLngBounds {
    const northWest = this.containerPointToLatLng([0, 0]);
    const southEast = this.containerPointToLatLng([this.#size.width, this.#size.height]);
    return bounds({ lat: southEast.lat, lng: northWest.lng }, { lat: northWest.lat, lng: southEast.lng });
  }

  #zoomForBounds(target: LatLngBounds, padding: number): number {
    const a = this.crs.project(target.getNorthWest(), 0);
    const b = this.crs.project(target.getSouthEast(), 0);
    const dx = Math.max(1e-9, Math.abs(b.x - a.x));
    const dy = Math.max(1e-9, Math.abs(b.y - a.y));
    const zx = Math.log2(Math.max(1, this.#size.width - padding * 2) / dx);
    const zy = Math.log2(Math.max(1, this.#size.height - padding * 2) / dy);
    return Math.max(0, Math.min(this.#options.maxZoom, Math.floor(Math.min(zx, zy))));
  }

  /**
   * Ecosystem-compatible terminal alias of {@link destroy}. Leaflet-shaped code
   * reaches for `map.remove()`; both spellings do the same irreversible teardown.
   */
  remove(): this {
    return this.destroy();
  }

  destroy(): this {
    if (this.#destroyed) return this;
    if (this.#wheelTimer) clearTimeout(this.#wheelTimer);
    this.stop();
    this.#endViewSession(true, true);
    for (const layer of [...this.#layers]) this.removeLayer(layer);
    for (const control of [...this.#controls]) this.removeControl(control);
    for (const unsubscribe of this.#unsub.splice(0)) unsubscribe();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.container.classList.remove("oh-map", "oh-dragging");
    for (const [name, value] of Object.entries({
      role: this.#initialA11y.role,
      "aria-label": this.#initialA11y.ariaLabel,
      tabindex: this.#initialA11y.tabIndex
    })) {
      if (value === null) this.container.removeAttribute(name);
      else this.container.setAttribute(name, value);
    }
    this.viewport.remove();
    this.#panes.control?.remove();
    for (const name of Object.keys(this.#panes)) delete this.#panes[name];
    this.#controlCorners = {} as Record<ControlPosition, HTMLDivElement>;
    this.#attributions.clear();
    this.#destroyed = true;
    try { this.emit("unload"); }
    finally { this.off(); }
    return this;
  }
}

export function createMap(container: string | HTMLElement, options?: MapOptions): Orihon {
  return new Orihon(container, options);
}
