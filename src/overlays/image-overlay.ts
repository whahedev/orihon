import { createEl, listen } from "../dom.js";
import type { LatLngBoundsLike } from "../geo.js";
import type { LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { MediaOverlay } from "./media-overlay.js";

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

export interface ImageOverlayEventMap {
  load: { originalEvent: Event };
  error: { originalEvent: Event; url: string };
}

export class ImageOverlay extends MediaOverlay<HTMLImageElement, ResolvedImageOverlayOptions, ImageOverlayEventMap> {
  url: string;
  image: HTMLImageElement | null = null;
  private _fallbackUsed = false;

  constructor(url: string, value: LatLngBoundsLike, options: ImageOverlayOptions = {}) {
    super(value, {
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
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.image = createEl("img");
    this.image.alt = this.options.alt;
    this.image.draggable = false;
    if (this.options.crossOrigin) this.image.crossOrigin = this.options.crossOrigin === true ? "anonymous" : this.options.crossOrigin;
    if (this.options.referrerPolicy) this.image.referrerPolicy = this.options.referrerPolicy;
    this._unsub.push(listen(this.image, "load", (event) => this.emit("load", { originalEvent: event })));
    this._unsub.push(listen(this.image, "error", (event) => {
      this.emit("error", { originalEvent: event, url: this.image?.currentSrc || this.url });
      if (!this._fallbackUsed && this.options.errorOverlayUrl && this.image) {
        this._fallbackUsed = true;
        this.image.src = this.options.errorOverlayUrl;
      }
    }));
    this.attachMediaElement(this.image, "oh-image-overlay");
    this.image.src = this.url;
  }

  protected override mediaElement(): HTMLImageElement | null { return this.image; }
  protected override clearMediaElement(): void { this.image = null; }

  setUrl(url: string): this {
    this.url = String(url);
    this._fallbackUsed = false;
    if (this.image) this.image.src = this.url;
    return this;
  }

}

export function imageOverlay(url: string, value: LatLngBoundsLike, options?: ImageOverlayOptions): ImageOverlay {
  return new ImageOverlay(url, value, options);
}
