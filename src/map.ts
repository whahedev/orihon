import { createEl, getContainer, listen, rafThrottle } from "./dom.js";
import { Evented } from "./events.js";
import {
  LatLng,
  LatLngBounds,
  Point,
  latLng,
  latLngBounds,
  point,
  project,
  unproject,
  zoomForBounds,
  type LatLngBoundsLike,
  type LatLngLike,
  type PointLike
} from "./geo.js";
import type { Layer } from "./layer.js";
import { AttributionControl, ScaleControl, ZoomControl, type Control } from "./ui/control.js";
import { resolveLocale, type OrihonLocale, type LocaleInput } from "./ui/locale.js";

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
  zoomAnimationDuration?: number;
  controls?: boolean;
  locale?: LocaleInput;
  ariaLabel?: string;
  keyboard?: boolean;
  keyboardPanDelta?: number;
  behaviors?: BehaviorOptions;
}

export interface MapSize {
  width: number;
  height: number;
}

export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type MapBehaviorName = "drag" | "scrollZoom" | "pinchZoom" | "dblClick" | "boxZoom";
export type BehaviorOptions = Partial<Record<MapBehaviorName, boolean>>;

type ResolvedMapOptions = Required<Omit<MapOptions, "behaviors" | "maxBounds">> & {
  behaviors: BehaviorOptions;
  maxBounds: LatLngBounds | null;
};

const DEFAULTS: ResolvedMapOptions = {
  center: [0, 0],
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
  zoomAnimationDuration: 0.25,
  controls: true,
  locale: "en",
  ariaLabel: "",
  keyboard: true,
  keyboardPanDelta: 80,
  behaviors: {}
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
  const target = latLngBounds(value);
  return target.isValid() ? target : null;
}

export class BehaviorManager {
  readonly map: Orihon;
  readonly states: Record<MapBehaviorName, boolean>;

  constructor(map: Orihon, options: BehaviorOptions = {}) {
    this.map = map;
    this.states = { ...DEFAULT_BEHAVIORS, ...options };
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
    return this.states[name] !== false;
  }

  getEnabled(): MapBehaviorName[] {
    return (Object.keys(this.states) as MapBehaviorName[]).filter((name) => this.isEnabled(name));
  }

  #set(name: MapBehaviorName, enabled: boolean): this {
    if (!(name in this.states)) throw new TypeError(`Unknown map behavior: ${name}`);
    const next = Boolean(enabled);
    if (this.states[name] === next) return this;
    this.states[name] = next;
    this.map.emit("behaviorchange", { name, enabled: next, behaviors: this.getEnabled() });
    return this;
  }
}

export class Orihon extends Evented {
  readonly options: ResolvedMapOptions;
  readonly container: HTMLElement;
  viewport!: HTMLDivElement;
  panes: Record<string, HTMLElement> = {};
  controlCorners = {} as Record<ControlPosition, HTMLDivElement>;
  center: LatLng;
  zoom: number;
  size: MapSize = { width: 0, height: 0 };
  pixelOrigin = new Point(0, 0);
  readonly layers = new Set<Layer>();
  readonly controls = new Set<Control>();
  readonly locale: OrihonLocale;
  readonly behaviors: BehaviorManager;
  readonly _attributions = new Map<string, number>();
  readonly _viewSession: ViewSession = { move: false, zoom: false };
  readonly _unsub: Array<() => void> = [];
  readonly _frameRender: () => void;
  _wheelTimer: ReturnType<typeof setTimeout> | null = null;
  _animationFrame: number | null = null;
  _animationActive = false;
  _resizeObserver: ResizeObserver | null = null;
  _destroyed = false;
  readonly _initialA11y: { role: string | null; ariaLabel: string | null; tabIndex: string | null };

  constructor(container: string | HTMLElement, options: MapOptions = {}) {
    super();
    this.options = {
      ...DEFAULTS,
      ...options,
      maxBounds: normalizeMaxBounds(options.maxBounds),
      behaviors: { ...DEFAULT_BEHAVIORS, ...options.behaviors }
    };
    this.container = getContainer(container);
    this.locale = resolveLocale(this.options.locale);
    this.behaviors = new BehaviorManager(this, this.options.behaviors);
    this._initialA11y = {
      role: this.container.getAttribute("role"),
      ariaLabel: this.container.getAttribute("aria-label"),
      tabIndex: this.container.getAttribute("tabindex")
    };
    this.center = latLng(this.options.center);
    this.zoom = this.#clampZoom(this.options.zoom);
    this._frameRender = rafThrottle(() => this.#render());
    this.#initDom();
    this.#bindInput();
    this.#bindResize();
    this.invalidateSize();
    if (this.options.controls) {
      new ZoomControl({ locale: this.locale }).addTo(this);
      new ScaleControl({ locale: this.locale }).addTo(this);
      new AttributionControl({ locale: this.locale }).addTo(this);
    }
    this.#render();
  }

  #initDom(): void {
    this.container.classList.add("oh-map");
    this.container.setAttribute("role", "application");
    this.container.setAttribute("aria-label", this.options.ariaLabel || this.locale.mapLabel);
    this.container.tabIndex = 0;
    this.viewport = createEl("div", "oh-viewport", this.container);
    this.createPane("tile", this.viewport, "oh-pane oh-tile-pane");
    this.createPane("overlay", this.viewport, "oh-pane oh-overlay-pane");
    this.createPane("marker", this.viewport, "oh-pane oh-marker-pane");
    this.createPane("tooltip", this.viewport, "oh-pane oh-tooltip-pane");
    this.createPane("popup", this.viewport, "oh-pane oh-popup-pane");
    this.createPane("control", this.container, "oh-control-pane");
    this.controlCorners = {
      "top-left": createEl("div", "oh-control-corner oh-top-left", this.panes.control),
      "top-right": createEl("div", "oh-control-corner oh-top-right", this.panes.control),
      "bottom-left": createEl("div", "oh-control-corner oh-bottom-left", this.panes.control),
      "bottom-right": createEl("div", "oh-control-corner oh-bottom-right", this.panes.control)
    };
  }

  #bindResize(): void {
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this.invalidateSize());
      this._resizeObserver.observe(this.container);
      return;
    }
    if (typeof window !== "undefined") {
      this._unsub.push(listen(window, "resize", () => this.invalidateSize(), { passive: true }));
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
        origin: project(this.center, this.zoom),
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
        zoom: this.zoom,
        anchor: this.containerPointToLatLng(midpoint)
      };
      this.#beginViewSession(true);
    };

    this._unsub.push(listen(this.container, "pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if ((event.target as Element | null)?.closest?.(".oh-control, .oh-marker")) return;
      event.preventDefault();
      this.container.setPointerCapture?.(event.pointerId);
      const pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, pointer);
      if (event.shiftKey && this.behaviors.isEnabled("boxZoom")) {
        beginBoxZoom(event, containerPoint(event.clientX, event.clientY));
        return;
      }
      if (pointers.size === 1 && this.behaviors.isEnabled("drag")) beginDrag(pointer);
      else if (pointers.size === 2 && this.behaviors.isEnabled("pinchZoom")) beginPinch();
    }));

    this._unsub.push(listen(this.container, "pointermove", (event) => {
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
        const projectedAnchor = project(gesture.anchor, nextZoom);
        const nextCenter = unproject({
          x: projectedAnchor.x - midpoint.x + this.size.width / 2,
          y: projectedAnchor.y - midpoint.y + this.size.height / 2
        }, nextZoom);
        this.#applyView(nextCenter, nextZoom);
        return;
      }

      if (gesture.type === "drag" && gesture.pointerId === event.pointerId) {
        const now = performance.now();
        const current = new Point(event.clientX, event.clientY);
        const elapsed = Math.max(1, now - gesture.lastTime);
        gesture.velocity = current.subtract(gesture.last).divideBy(elapsed / 1000);
        gesture.last = current;
        gesture.lastTime = now;
        const dx = event.clientX - gesture.start.x;
        const dy = event.clientY - gesture.start.y;
        if (Math.hypot(dx, dy) > 3) gesture.moved = true;
        const nextCenter = unproject({ x: gesture.origin.x - dx, y: gesture.origin.y - dy }, this.zoom);
        this.#applyView(nextCenter, this.zoom);
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
          bounds: latLngBounds(
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
      if (dragVelocity && this.options.inertia) this.#startInertia(dragVelocity);
    };
    this._unsub.push(listen(this.container, "pointerup", stopPointer));
    this._unsub.push(listen(this.container, "pointercancel", stopPointer));

    this._unsub.push(listen(this.container, "wheel", (event) => {
      if (!this.behaviors.isEnabled("scrollZoom")) return;
      event.preventDefault();
      if (pointers.size) return;
      const anchor = containerPoint(event.clientX, event.clientY);
      const next = this.zoom - Math.sign(event.deltaY) * this.options.wheelZoomStep;
      if (this.#clampZoom(next) === this.zoom) return;
      this.#beginViewSession(true);
      this.#applyZoomAround(anchor, next);
      if (this._wheelTimer) clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => this.#endViewSession(true, true), 140);
    }, { passive: false }));

    this._unsub.push(listen(this.container, "dblclick", (event) => {
      if (!this.behaviors.isEnabled("dblClick")) return;
      event.preventDefault();
      this.setZoomAround(containerPoint(event.clientX, event.clientY), this.zoom + 1);
    }));

    this._unsub.push(listen(this.container, "click", (event) => {
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

    this._unsub.push(listen(this.container, "keydown", (event) => {
      if (!this.options.keyboard || event.target !== this.container) return;
      const delta = this.options.keyboardPanDelta;
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
        this.setZoom(this.zoom + 1);
      } else if (event.key === "-" || event.key === "_" || event.key === "PageDown") {
        event.preventDefault();
        this.setZoom(this.zoom - 1);
      }
    }));
  }

  #clampZoom(zoom: number): number {
    const snap = Number(this.options.zoomSnap);
    const numericZoom = Number(zoom);
    const snapped = snap > 0 ? Math.round(numericZoom / snap) * snap : numericZoom;
    return Math.max(this.options.minZoom, Math.min(this.options.maxZoom, snapped));
  }

  #pixelOriginFor(center = this.center, zoom = this.zoom): Point {
    const centerPoint = project(center, zoom);
    return new Point(centerPoint.x - this.size.width / 2, centerPoint.y - this.size.height / 2);
  }

  #limitCenter(center: LatLng, zoom: number): LatLng {
    const maxBounds = this.options.maxBounds;
    if (!maxBounds || this.options.maxBoundsViscosity <= 0 || !maxBounds.isValid()) return center;
    if (this.size.width <= 0 || this.size.height <= 0) return center;
    const northWest = project(maxBounds.getNorthWest(), zoom);
    const southEast = project(maxBounds.getSouthEast(), zoom);
    const projected = project(center, zoom);
    const minX = northWest.x + this.size.width / 2;
    const maxX = southEast.x - this.size.width / 2;
    const minY = northWest.y + this.size.height / 2;
    const maxY = southEast.y - this.size.height / 2;
    const clamp = (value: number, min: number, max: number): number => {
      if (min > max) return (min + max) / 2;
      return Math.max(min, Math.min(max, value));
    };
    return unproject({
      x: clamp(projected.x, minX, maxX),
      y: clamp(projected.y, minY, maxY)
    }, zoom);
  }

  #cancelAnimation(): void {
    if (this._animationFrame !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this._animationFrame);
    this._animationFrame = null;
    this._animationActive = false;
  }

  #scheduleAnimation(callback: FrameRequestCallback): void {
    if (typeof requestAnimationFrame !== "undefined") this._animationFrame = requestAnimationFrame(callback);
    else this._animationFrame = setTimeout(() => callback(performance.now()), 16) as unknown as number;
  }

  #animateView(center: LatLngLike, zoom: number, durationSeconds = this.options.zoomAnimationDuration): this {
    const targetCenter = this.#limitCenter(latLng(center), this.#clampZoom(zoom));
    const targetZoom = this.#clampZoom(zoom);
    const startCenter = this.center.clone();
    const startZoom = this.zoom;
    const zoomChanged = targetZoom !== startZoom;
    const duration = Math.max(0, durationSeconds) * 1000;
    this.stop();
    if (duration === 0) return this.setView(targetCenter, targetZoom);
    this._animationActive = true;
    this.#beginViewSession(zoomChanged);
    const startTime = performance.now();
    const ease = (t: number): number => 1 - (1 - t) ** 3;
    const frame = (now: number): void => {
      if (!this._animationActive || this._destroyed) return;
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = ease(progress);
      this.#applyView([
        startCenter.lat + (targetCenter.lat - startCenter.lat) * eased,
        startCenter.lng + (targetCenter.lng - startCenter.lng) * eased
      ], startZoom + (targetZoom - startZoom) * eased);
      if (progress < 1) {
        this.#scheduleAnimation(frame);
        return;
      }
      this._animationFrame = null;
      this._animationActive = false;
      this.#endViewSession(zoomChanged, true);
    };
    this.#scheduleAnimation(frame);
    return this;
  }

  #startInertia(velocity: Point): void {
    const speed = Math.min(this.options.inertiaMaxSpeed, Math.hypot(velocity.x, velocity.y));
    if (speed < 80) return;
    const direction = velocity.divideBy(Math.max(1, Math.hypot(velocity.x, velocity.y)));
    const duration = speed / Math.max(1, this.options.inertiaDeceleration);
    const travel = direction.multiplyBy((speed * duration) / 2);
    const origin = project(this.center, this.zoom);
    const startTime = performance.now();
    this.stop();
    this._animationActive = true;
    this.#beginViewSession(false);
    const frame = (now: number): void => {
      if (!this._animationActive || this._destroyed) return;
      const progress = Math.min(1, (now - startTime) / (duration * 1000));
      const eased = 1 - (1 - progress) ** 2;
      this.#applyView(unproject(origin.subtract(travel.multiplyBy(eased)), this.zoom), this.zoom);
      if (progress < 1) {
        this.#scheduleAnimation(frame);
        return;
      }
      this._animationFrame = null;
      this._animationActive = false;
      this.#endViewSession(false, true);
    };
    this.#scheduleAnimation(frame);
  }

  #zoomToContainerBox(start: Point, end: Point): this {
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < 8 || height < 8) return this;
    const centerPoint = start.add(end).divideBy(2);
    const scale = Math.min(this.size.width / Math.max(1, width), this.size.height / Math.max(1, height));
    const nextZoom = this.#clampZoom(this.zoom + Math.log2(Math.max(1, scale)));
    return this.setView(this.containerPointToLatLng(centerPoint), nextZoom);
  }

  #beginViewSession(withZoom: boolean): void {
    if (!this._viewSession.move) {
      this._viewSession.move = true;
      this.emit("movestart", { center: this.center });
    }
    if (withZoom && !this._viewSession.zoom) {
      this._viewSession.zoom = true;
      this.emit("zoomstart", { zoom: this.zoom });
    }
  }

  #endViewSession(withZoom: boolean, withMove: boolean): void {
    if (withZoom && this._viewSession.zoom) {
      this._viewSession.zoom = false;
      this.emit("zoomend", { zoom: this.zoom });
    }
    if (withMove && this._viewSession.move) {
      this._viewSession.move = false;
      this.emit("moveend", { center: this.center });
    }
  }

  #applyView(center: LatLngLike, zoom: number, syncRender = false): boolean {
    if (this._destroyed) return false;
    const nextZoom = this.#clampZoom(zoom);
    const nextCenter = this.#limitCenter(latLng(center), nextZoom);
    const zoomChanged = nextZoom !== this.zoom;
    const centerChanged = !nextCenter.equals(this.center, 0);
    if (!zoomChanged && !centerChanged) return false;
    this.center = nextCenter;
    this.zoom = nextZoom;
    this.pixelOrigin = this.#pixelOriginFor();
    if (zoomChanged) this.emit("zoom", { zoom: this.zoom });
    this.emit("move", { center: this.center });
    if (syncRender) this.#render();
    else this._frameRender();
    return true;
  }

  #applyZoomAround(anchor: PointLike, zoom: number): boolean {
    const anchorPoint = point(anchor);
    const nextZoom = this.#clampZoom(zoom);
    if (nextZoom === this.zoom) return false;
    const before = this.containerPointToLatLng(anchorPoint);
    const afterPoint = project(before, nextZoom);
    const nextCenter = unproject({
      x: afterPoint.x - anchorPoint.x + this.size.width / 2,
      y: afterPoint.y - anchorPoint.y + this.size.height / 2
    }, nextZoom);
    return this.#applyView(nextCenter, nextZoom);
  }

  #render(): void {
    if (this._destroyed) return;
    this.pixelOrigin = this.#pixelOriginFor();
    for (const layer of this.layers) layer.render();
    for (const control of this.controls) control.render();
  }

  createPane(name: string, container: HTMLElement = this.viewport, className = `oh-pane oh-${name}-pane`): HTMLElement {
    if (!name) throw new TypeError("Pane name is required");
    const existing = this.panes[name];
    if (existing) return existing;
    const pane = createEl("div", className, container);
    this.panes[name] = pane;
    return pane;
  }

  getPane(name = "overlay"): HTMLElement | null {
    return this.panes[name] ?? null;
  }

  getPanes(): Readonly<Record<string, HTMLElement>> {
    return this.panes;
  }

  removePane(name: string): this {
    if (DEFAULT_PANES.has(name)) return this;
    const pane = this.panes[name];
    if (!pane) return this;
    pane.remove();
    delete this.panes[name];
    return this;
  }

  invalidateSize(): this {
    if (this._destroyed) return this;
    const previous = this.size;
    const rect = this.container.getBoundingClientRect();
    const next = {
      width: rect.width || this.container.clientWidth,
      height: rect.height || this.container.clientHeight
    };
    this.size = next;
    if (previous.width > 0 && previous.height > 0 && (previous.width !== next.width || previous.height !== next.height)) {
      this.emit("resize", { oldSize: new Point(previous.width, previous.height), newSize: new Point(next.width, next.height) });
    }
    // Container resizing must re-anchor panes before the browser paints the new layout.
    this.#render();
    return this;
  }

  getContainer(): HTMLElement { return this.container; }
  getCenter(): LatLng { return this.center.clone(); }
  getZoom(): number { return this.zoom; }
  getSize(): Point { return new Point(this.size.width, this.size.height); }
  getMaxBounds(): LatLngBounds | null { return this.options.maxBounds ? new LatLngBounds(this.options.maxBounds) : null; }

  setLocale(input: LocaleInput): this {
    Object.assign(this.locale, resolveLocale(input));
    if (!this.options.ariaLabel) {
      this.container.setAttribute("aria-label", this.locale.mapLabel);
    }
    for (const control of this.controls) {
      Object.assign(control.locale, this.locale);
      control.render();
    }
    this.emit("localechange", { locale: this.locale });
    return this;
  }

  addLayer(layer: Layer): this {
    if (this.layers.has(layer)) return this;
    this.layers.add(layer);
    layer.onAdd(this);
    layer.render();
    layer.emit("add", { map: this }, false);
    this.emit("layeradd", { layer });
    return this;
  }

  removeLayer(layer: Layer): this {
    if (!this.layers.delete(layer)) return this;
    layer.onRemove();
    layer.emit("remove", { map: this }, false);
    this.emit("layerremove", { layer });
    return this;
  }

  hasLayer(layer: Layer): boolean {
    return this.layers.has(layer);
  }

  eachLayer(callback: (layer: Layer) => void, context?: unknown): this {
    for (const layer of [...this.layers]) callback.call(context, layer);
    return this;
  }

  addControl(control: Control): this {
    if (this.controls.has(control)) return this;
    this.controls.add(control);
    control.onAdd(this);
    control.render();
    return this;
  }

  removeControl(control: Control): this {
    if (!this.controls.delete(control)) return this;
    control.onRemove();
    return this;
  }

  addAttribution(value: string): this {
    const text = String(value || "").trim();
    if (!text) return this;
    this._attributions.set(text, (this._attributions.get(text) || 0) + 1);
    this.emit("attributionchange", { attributions: this.getAttributions() });
    return this;
  }

  removeAttribution(value: string): this {
    const text = String(value || "").trim();
    const count = this._attributions.get(text);
    if (!count) return this;
    if (count === 1) this._attributions.delete(text);
    else this._attributions.set(text, count - 1);
    this.emit("attributionchange", { attributions: this.getAttributions() });
    return this;
  }

  getAttributions(): string[] {
    return [...this._attributions.keys()];
  }

  setMaxBounds(value: LatLngBoundsLike | null): this {
    this.options.maxBounds = normalizeMaxBounds(value);
    if (this.options.maxBounds) this.panInsideBounds(this.options.maxBounds);
    return this;
  }

  panInsideBounds(value: LatLngBoundsLike, options: { animate?: boolean; duration?: number } = {}): this {
    const target = latLngBounds(value);
    if (!target.isValid()) return this;
    const bounds = this.getBounds();
    if (target.contains(bounds)) return this;
    const nextCenter = this.#limitCenter(this.center, this.zoom);
    return options.animate ? this.flyTo(nextCenter, this.zoom, options) : this.setView(nextCenter, this.zoom);
  }

  setView(center: LatLngLike, zoom = this.zoom): this {
    if (this._destroyed) return this;
    this.stop();
    const nextCenter = latLng(center);
    const nextZoom = this.#clampZoom(zoom);
    const zoomChanged = nextZoom !== this.zoom;
    const centerChanged = !nextCenter.equals(this.center, 0);
    if (!zoomChanged && !centerChanged) return this;
    this.#beginViewSession(zoomChanged);
    // Sync render: programmatic jumps (bench / API) should paint this frame, not the next rAF.
    this.#applyView(nextCenter, nextZoom, true);
    this.#endViewSession(zoomChanged, true);
    return this;
  }

  panTo(center: LatLngLike): this { return this.setView(center, this.zoom); }
  panBy(offset: PointLike): this {
    const nextCenter = unproject(project(this.center, this.zoom).add(point(offset)), this.zoom);
    return this.panTo(nextCenter);
  }
  setZoom(zoom: number): this { return this.setView(this.center, zoom); }
  zoomIn(delta = 1): this { return this.setZoom(this.zoom + delta); }
  zoomOut(delta = 1): this { return this.setZoom(this.zoom - delta); }

  setZoomAround(anchor: PointLike, zoom: number): this {
    this.stop();
    if (this.#clampZoom(zoom) === this.zoom) return this;
    this.#beginViewSession(true);
    this.#applyZoomAround(anchor, zoom);
    this.#endViewSession(true, true);
    return this;
  }

  fitBounds(value: LatLngBoundsLike, options: { padding?: number; animate?: boolean; duration?: number } = {}): this {
    const target = latLngBounds(value);
    const zoom = zoomForBounds(this.size, target, options.padding ?? 32, this.options.maxZoom);
    return options.animate ? this.flyTo(target.getCenter(), zoom, options) : this.setView(target.getCenter(), zoom);
  }

  fitWorld(options: { padding?: number; animate?: boolean; duration?: number } = {}): this {
    return this.fitBounds([[-85.0511287798066, -180], [85.0511287798066, 180]], options);
  }

  flyTo(center: LatLngLike, zoom = this.zoom, options: { duration?: number } = {}): this {
    return this.#animateView(center, zoom, options.duration ?? this.options.zoomAnimationDuration);
  }

  flyToBounds(value: LatLngBoundsLike, options: { padding?: number; duration?: number } = {}): this {
    const target = latLngBounds(value);
    const zoom = zoomForBounds(this.size, target, options.padding ?? 32, this.options.maxZoom);
    return this.flyTo(target.getCenter(), zoom, options);
  }

  stop(): this {
    if (!this._animationActive && this._animationFrame === null) return this;
    this.#cancelAnimation();
    this.#endViewSession(true, true);
    return this;
  }

  latLngToLayerPoint(value: LatLngLike): Point {
    return project(value, this.zoom).subtract(this.pixelOrigin);
  }

  latLngToContainerPoint(value: LatLngLike): Point {
    return project(value, this.zoom).subtract(this.pixelOrigin);
  }

  containerPointToLatLng(value: PointLike): LatLng {
    const source = point(value);
    return unproject(source.add(this.pixelOrigin), this.zoom);
  }

  getBounds(): LatLngBounds {
    const northWest = this.containerPointToLatLng([0, 0]);
    const southEast = this.containerPointToLatLng([this.size.width, this.size.height]);
    return latLngBounds([southEast.lat, northWest.lng], [northWest.lat, southEast.lng]);
  }

  remove(): this {
    return this.destroy();
  }

  destroy(): this {
    if (this._destroyed) return this;
    if (this._wheelTimer) clearTimeout(this._wheelTimer);
    this.stop();
    this.#endViewSession(true, true);
    for (const layer of [...this.layers]) this.removeLayer(layer);
    for (const control of [...this.controls]) this.removeControl(control);
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this.container.classList.remove("oh-map", "oh-dragging");
    for (const [name, value] of Object.entries({
      role: this._initialA11y.role,
      "aria-label": this._initialA11y.ariaLabel,
      tabindex: this._initialA11y.tabIndex
    })) {
      if (value === null) this.container.removeAttribute(name);
      else this.container.setAttribute(name, value);
    }
    this.viewport.remove();
    this.panes.control?.remove();
    this.panes = {};
    this._attributions.clear();
    this._destroyed = true;
    this.off();
    return this;
  }
}

export function createMap(container: string | HTMLElement, options?: MapOptions): Orihon {
  return new Orihon(container, options);
}
