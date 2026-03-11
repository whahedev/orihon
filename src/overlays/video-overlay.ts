import { createEl, listen } from "../dom.js";
import type { LatLngBoundsLike } from "../geo.js";
import type { LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { MediaOverlay } from "./media-overlay.js";

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

export interface VideoOverlayEventMap {
  load: { originalEvent: Event };
  error: { originalEvent: Event };
}

export class VideoOverlay extends MediaOverlay<HTMLVideoElement, ResolvedVideoOverlayOptions, VideoOverlayEventMap> {
  urls: string[];
  video: HTMLVideoElement | null = null;

  constructor(url: string | string[], value: LatLngBoundsLike, options: VideoOverlayOptions = {}) {
    super(value, {
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
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.video = createEl("video");
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
    this.attachMediaElement(this.video, "oh-video-overlay");
    this.#setSources();
    this._unsub.push(listen(this.video, "loadeddata", (event) => {
      this.emit("load", { originalEvent: event });
      this.#tryPlay();
    }));
    this._unsub.push(listen(this.video, "canplay", () => this.#tryPlay()));
    this._unsub.push(listen(this.video, "canplaythrough", () => this.#tryPlay()));
    this._unsub.push(listen(this.video, "error", (event) => this.emit("error", { originalEvent: event })));
    this.#tryPlay();
    // Second video often stays paused until another play tick.
    window.setTimeout(() => this.#tryPlay(), 0);
    window.setTimeout(() => this.#tryPlay(), 500);
  }

  override onRemove(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    super.onRemove();
  }

  protected override mediaElement(): HTMLVideoElement | null { return this.video; }
  protected override clearMediaElement(): void { this.video = null; }

  setUrl(url: string | string[]): this {
    this.urls = (Array.isArray(url) ? url : [url]).map(String);
    this.#setSources();
    return this;
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

}

export function videoOverlay(url: string | string[], value: LatLngBoundsLike, options?: VideoOverlayOptions): VideoOverlay {
  return new VideoOverlay(url, value, options);
}
