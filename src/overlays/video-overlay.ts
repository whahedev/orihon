import { createEl, listen, listenTap } from "../dom.js";
import { LatLngBounds, latLngBounds, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions } from "./div-overlay.js";

export interface VideoOverlayOptions extends LayerOptions {
  opacity?: number;
  className?: string;
  interactive?: boolean;
  zIndex?: number;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  playsInline?: boolean;
  controls?: boolean;
  poster?: string;
}

interface ResolvedVideoOverlayOptions extends LayerOptions {
  pane: string;
  attribution: string;
  opacity: number;
  className: string;
  interactive: boolean;
  zIndex: number;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  playsInline: boolean;
  controls: boolean;
  poster: string;
}

export class VideoOverlay extends Layer<ResolvedVideoOverlayOptions> {
  urls: string[];
  overlayBounds: LatLngBounds;
  video: HTMLVideoElement | null = null;
  readonly _unsub: Array<() => void> = [];
  private _interactiveUnsub: (() => void) | null = null;

  constructor(url: string | string[], value: LatLngBoundsLike, options: VideoOverlayOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      opacity: 1,
      className: "",
      interactive: false,
      zIndex: 0,
      autoplay: true,
      loop: true,
      muted: true,
      playsInline: true,
      controls: false,
      poster: "",
      ...options
    } as ResolvedVideoOverlayOptions);
    this.urls = (Array.isArray(url) ? url : [url]).map(String);
    this.overlayBounds = new LatLngBounds(latLngBounds(value));
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.video = createEl("video", `oh-video-overlay ${this.options.className}`.trim(), pane);
    this.video.style.opacity = String(this.options.opacity);
    this.video.style.zIndex = String(this.options.zIndex);
    this.video.autoplay = this.options.autoplay;
    this.video.loop = this.options.loop;
    this.video.muted = this.options.muted;
    this.video.defaultMuted = this.options.muted;
    this.video.playsInline = this.options.playsInline;
    this.video.controls = this.options.controls;
    if (this.options.muted) this.video.setAttribute("muted", "");
    if (this.options.playsInline) this.video.setAttribute("playsinline", "");
    if (this.options.autoplay) this.video.setAttribute("autoplay", "");
    if (this.options.poster) this.video.poster = this.options.poster;
    this.video.draggable = false;
    this.video.preload = "auto";
    this.video.setAttribute("disablepictureinpicture", "");
    this.#setSources();
    this.#syncInteractive();
    this._unsub.push(listen(this.video, "loadeddata", (event) => {
      this.emit("load", { originalEvent: event });
      this.#tryPlay();
    }));
    this._unsub.push(listen(this.video, "canplay", () => this.#tryPlay()));
    this._unsub.push(listen(this.video, "canplaythrough", () => this.#tryPlay()));
    this._unsub.push(listen(this.video, "error", (event) => this.emit("error", { originalEvent: event })));
    this.render();
    this.#tryPlay();
    // Second video often stays paused until another play tick.
    window.setTimeout(() => this.#tryPlay(), 0);
    window.setTimeout(() => this.#tryPlay(), 500);
  }

  override onRemove(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video.remove();
    }
    this.video = null;
    super.onRemove();
  }

  setUrl(url: string | string[]): this {
    this.urls = (Array.isArray(url) ? url : [url]).map(String);
    this.#setSources();
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
    if (this.video) this.video.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndex(zIndex: number): this {
    this.options.zIndex = Number(zIndex);
    if (this.video) this.video.style.zIndex = String(this.options.zIndex);
    return this;
  }

  bringToFront(): this { return this.#moveToEdge(true); }
  bringToBack(): this { return this.#moveToEdge(false); }
  getElement(): HTMLVideoElement | null { return this.video; }

  override render(): void {
    if (!this.map || !this.video) return;
    const northWest = this.map.latLngToLayerPoint(this.overlayBounds.getNorthWest());
    const southEast = this.map.latLngToLayerPoint(this.overlayBounds.getSouthEast());
    this.video.style.left = `${northWest.x}px`;
    this.video.style.top = `${northWest.y}px`;
    this.video.style.width = `${Math.max(0, southEast.x - northWest.x)}px`;
    this.video.style.height = `${Math.max(0, southEast.y - northWest.y)}px`;
  }

  #setSources(): void {
    if (!this.video) return;
    this.video.textContent = "";
    for (const url of this.urls) {
      const source = document.createElement("source");
      source.src = url;
      const lower = url.toLowerCase();
      if (lower.includes(".webm")) source.type = "video/webm";
      else if (lower.includes(".ogv") || lower.includes(".ogg")) source.type = "video/ogg";
      else if (lower.includes(".mp4")) source.type = "video/mp4";
      this.video.appendChild(source);
    }
    if (this.urls.length === 1) this.video.src = this.urls[0];
    this.video.load();
    this.#tryPlay();
  }

  #tryPlay(): void {
    if (!this.video || !this.options.autoplay) return;
    const play = this.video.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  }

  #syncInteractive(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    if (!this.video || !this.map || !this.options.interactive) return;
    this.video.classList.add("oh-interactive");
    this._interactiveUnsub = listenTap(this.video, (event) => {
      event.stopPropagation();
      const rect = this.map!.container.getBoundingClientRect();
      this.emit("click", {
        originalEvent: event,
        latlng: this.map!.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top])
      });
    });
  }

  #moveToEdge(front: boolean): this {
    const element = this.video;
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

export function videoOverlay(url: string | string[], value: LatLngBoundsLike, options?: VideoOverlayOptions): VideoOverlay {
  return new VideoOverlay(url, value, options);
}
