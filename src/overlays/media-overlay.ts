import { listenTap } from "../dom.js";
import { LatLngBounds, bounds, type LatLng, type LatLngBoundsLike } from "../geo.js";
import { InteractiveLayer, type LayerOptions } from "../layer.js";
import type { OverlayContent, PopupOptions } from "./div-overlay.js";

export interface ResolvedMediaOverlayOptions extends LayerOptions {
  pane: string;
  attribution: string;
  opacity: number;
  className: string;
  interactive: boolean;
  zIndex: number;
}

export interface MediaOverlayEventMap {
  click: { originalEvent: MouseEvent | PointerEvent; latlng: LatLng };
}

/** Internal shared lifecycle for image, video and SVG overlays. */
export abstract class MediaOverlay<
  TElement extends HTMLElement | SVGElement,
  TOptions extends ResolvedMediaOverlayOptions,
  TEvents extends object = {}
> extends InteractiveLayer<TOptions, MediaOverlayEventMap & TEvents> {
  overlayBounds: LatLngBounds;
  readonly _unsub: Array<() => void> = [];
  private _interactiveUnsub: (() => void) | null = null;

  protected constructor(value: LatLngBoundsLike, options: TOptions) {
    super(options);
    this.overlayBounds = new LatLngBounds(bounds(value));
  }

  protected abstract mediaElement(): TElement | null;
  protected abstract clearMediaElement(): void;

  protected attachMediaElement(element: TElement, baseClass: string): void {
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    element.classList.add(baseClass);
    if (this.options.className) element.classList.add(...this.options.className.split(/\s+/).filter(Boolean));
    element.style.opacity = String(this.options.opacity);
    element.style.zIndex = String(this.options.zIndex);
    pane.appendChild(element);
    this.syncInteractive();
    this.render();
  }

  protected resetMediaElement(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    this.mediaElement()?.remove();
    this.clearMediaElement();
  }

  override onRemove(): void {
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.resetMediaElement();
    super.onRemove();
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.writableOptions.interactive = true;
    this.syncInteractive();
    return super.bindPopup(content, options);
  }

  setBounds(value: LatLngBoundsLike): this {
    this.overlayBounds = new LatLngBounds(bounds(value));
    this.render();
    return this;
  }

  getBounds(): LatLngBounds {
    return new LatLngBounds(this.overlayBounds);
  }

  setOpacity(opacity: number): this {
    this.writableOptions.opacity = Math.max(0, Math.min(1, Number(opacity)));
    const element = this.mediaElement();
    if (element) element.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndex(zIndex: number): this {
    this.writableOptions.zIndex = Number(zIndex);
    const element = this.mediaElement();
    if (element) element.style.zIndex = String(this.options.zIndex);
    return this;
  }

  bringToFront(): this { return this.moveToEdge(true); }
  bringToBack(): this { return this.moveToEdge(false); }
  getElement(): TElement | null { return this.mediaElement(); }

  override render(): void {
    const element = this.mediaElement();
    if (!this.map || !element) return;
    const northWest = this.map.latLngToLayerPoint(this.overlayBounds.getNorthWest());
    const southEast = this.map.latLngToLayerPoint(this.overlayBounds.getSouthEast());
    element.style.left = `${northWest.x}px`;
    element.style.top = `${northWest.y}px`;
    element.style.width = `${Math.max(0, southEast.x - northWest.x)}px`;
    element.style.height = `${Math.max(0, southEast.y - northWest.y)}px`;
  }

  protected syncInteractive(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    const element = this.mediaElement();
    if (!element || !this.map || !this.options.interactive) return;
    element.classList.add("oh-interactive");
    this._interactiveUnsub = listenTap(element, (event) => {
      event.stopPropagation();
      const rect = this.map!.container.getBoundingClientRect();
      this.emit("click", {
        originalEvent: event,
        latlng: this.map!.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top])
      });
    });
  }

  private moveToEdge(front: boolean): this {
    const element = this.mediaElement();
    const parent = element?.parentElement;
    if (!element || !parent) return this;
    const siblingZIndexes = Array.from(parent.children, (child) => {
      const value = Number.parseInt(getComputedStyle(child).zIndex, 10);
      return Number.isFinite(value) ? value : 0;
    });
    const edge = front ? Math.max(0, ...siblingZIndexes) + 1 : Math.min(0, ...siblingZIndexes) - 1;
    this.setZIndex(edge);
    if (front) parent.appendChild(element);
    else parent.prepend(element);
    return this;
  }
}
