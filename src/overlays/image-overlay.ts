import { createEl, listen } from "../dom.js";
import { LatLngBounds, latLngBounds, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions } from "./div-overlay.js";

export interface ImageOverlayOptions extends LayerOptions {
  opacity?: number;
  alt?: string;
  className?: string;
  crossOrigin?: boolean | string;
  referrerPolicy?: ReferrerPolicy | "";
  errorOverlayUrl?: string;
  interactive?: boolean;
  zIndex?: number;
}

interface ResolvedImageOverlayOptions extends LayerOptions {
  pane: string;
  attribution: string;
  opacity: number;
  alt: string;
  className: string;
  crossOrigin: boolean | string;
  referrerPolicy: ReferrerPolicy | "";
  errorOverlayUrl: string;
  interactive: boolean;
  zIndex: number;
}

export class ImageOverlay extends Layer<ResolvedImageOverlayOptions> {
  url: string;
  overlayBounds: LatLngBounds;
  image: HTMLImageElement | null = null;
  readonly _unsub: Array<() => void> = [];
  private _fallbackUsed = false;
  private _interactiveUnsub: (() => void) | null = null;

  constructor(url: string, value: LatLngBoundsLike, options: ImageOverlayOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      opacity: 1,
      alt: "",
      className: "",
      crossOrigin: false,
      referrerPolicy: "",
      errorOverlayUrl: "",
      interactive: false,
      zIndex: 0,
      ...options
    } as ResolvedImageOverlayOptions);
    this.url = String(url);
    this.overlayBounds = new LatLngBounds(latLngBounds(value));
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.image = createEl("img", `oh-image-overlay ${this.options.className}`.trim(), pane);
    this.image.alt = this.options.alt;
    this.image.draggable = false;
    this.image.style.opacity = String(this.options.opacity);
    this.image.style.zIndex = String(this.options.zIndex);
    if (this.options.crossOrigin) this.image.crossOrigin = this.options.crossOrigin === true ? "anonymous" : this.options.crossOrigin;
    if (this.options.referrerPolicy) this.image.referrerPolicy = this.options.referrerPolicy;
    this.#syncInteractive();
    this._unsub.push(listen(this.image, "load", (event) => this.emit("load", { originalEvent: event })));
    this._unsub.push(listen(this.image, "error", (event) => {
      this.emit("error", { originalEvent: event, url: this.image?.currentSrc || this.url });
      if (!this._fallbackUsed && this.options.errorOverlayUrl && this.image) {
        this._fallbackUsed = true;
        this.image.src = this.options.errorOverlayUrl;
      }
    }));
    this.image.src = this.url;
    this.render();
  }

  override onRemove(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.image?.remove();
    this.image = null;
    super.onRemove();
  }

  setUrl(url: string): this {
    this.url = String(url);
    this._fallbackUsed = false;
    if (this.image) this.image.src = this.url;
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.options.interactive = true;
    this.#syncInteractive();
    return super.bindPopup(content, options);
  }

  setBounds(value: LatLngBoundsLike): this {
    this.overlayBounds = new LatLngBounds(latLngBounds(value));
    this.render();
    return this;
  }

  getBounds(): LatLngBounds {
    return new LatLngBounds(this.overlayBounds);
  }

  setOpacity(opacity: number): this {
    this.options.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.image) this.image.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndex(zIndex: number): this {
    this.options.zIndex = Number(zIndex);
    if (this.image) this.image.style.zIndex = String(this.options.zIndex);
    return this;
  }

  bringToFront(): this {
    this.#moveToEdge(true);
    return this;
  }

  bringToBack(): this {
    this.#moveToEdge(false);
    return this;
  }

  getElement(): HTMLImageElement | null {
    return this.image;
  }

  override render(): void {
    if (!this.map || !this.image) return;
    const northWest = this.map.latLngToLayerPoint(this.overlayBounds.getNorthWest());
    const southEast = this.map.latLngToLayerPoint(this.overlayBounds.getSouthEast());
    this.image.style.left = `${northWest.x}px`;
    this.image.style.top = `${northWest.y}px`;
    this.image.style.width = `${Math.max(0, southEast.x - northWest.x)}px`;
    this.image.style.height = `${Math.max(0, southEast.y - northWest.y)}px`;
  }

  #moveToEdge(front: boolean): void {
    const image = this.image;
    const parent = image?.parentElement;
    if (!image || !parent) return;
    const siblingZIndexes = Array.from(parent.children, (element) => {
      const value = Number.parseInt(getComputedStyle(element).zIndex, 10);
      return Number.isFinite(value) ? value : 0;
    });
    const edge = front
      ? Math.max(0, ...siblingZIndexes) + 1
      : Math.min(0, ...siblingZIndexes) - 1;
    this.setZIndex(edge);
    if (front) parent.appendChild(image);
    else parent.prepend(image);
  }

  #syncInteractive(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    if (!this.image || !this.map || !this.options.interactive) return;
    this.image.classList.add("oh-interactive");
    this._interactiveUnsub = listen(this.image, "click", (event) => {
      event.stopPropagation();
      const rect = this.map!.container.getBoundingClientRect();
      this.emit("click", {
        originalEvent: event,
        latlng: this.map!.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top])
      });
    });
  }
}

export function imageOverlay(url: string, value: LatLngBoundsLike, options?: ImageOverlayOptions): ImageOverlay {
  return new ImageOverlay(url, value, options);
}
