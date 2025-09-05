import { createEl, listen, setTransform } from "../dom.js";
import { LatLng, latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { MarkerIcon } from "./icon.js";

export interface MarkerOptions extends LayerOptions {
  title?: string;
  className?: string;
  draggable?: boolean;
  anchor?: [number, number];
  content?: Node | string | number | null;
  html?: string;
  ariaLabel?: string;
  icon?: MarkerIcon | null;
  opacity?: number;
  zIndexOffset?: number;
  keyboard?: boolean;
}

type ResolvedMarkerOptions = Required<Omit<MarkerOptions, "pane" | "attribution" | "content" | "icon">> &
  Pick<MarkerOptions, "pane" | "attribution"> & {
    content: Node | string | number | null;
    icon: MarkerIcon | null;
  };

export class Marker extends Layer<ResolvedMarkerOptions> {
  position: LatLng;
  el: HTMLButtonElement | null = null;
  iconElement: HTMLElement | null = null;
  shadowElement: HTMLElement | null = null;
  readonly _unsub: Array<() => void> = [];

  constructor(position: LatLngLike, options: MarkerOptions = {}) {
    super({
      pane: "marker",
      title: "",
      className: "",
      draggable: false,
      anchor: [12, 36],
      content: null,
      html: "",
      ariaLabel: "",
      icon: null,
      opacity: 1,
      zIndexOffset: 0,
      keyboard: true,
      ...options
    } as ResolvedMarkerOptions);
    this.position = latLng(position);
    this.options.opacity = Math.max(0, Math.min(1, Number(this.options.opacity)));
    this.options.zIndexOffset = Number.isFinite(Number(this.options.zIndexOffset)) ? Number(this.options.zIndexOffset) : 0;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.el = createEl("button", `oh-marker ${this.options.className}`, pane);
    this.el.type = "button";
    this.el.title = this.options.title;
    this.el.setAttribute("aria-label", this.options.ariaLabel || this.options.title || "Map marker");
    this.el.tabIndex = this.options.keyboard ? 0 : -1;
    this.el.style.opacity = String(this.options.opacity);
    this.#setContent();
    this._unsub.push(listen(this.el, "click", (event) => {
      event.stopPropagation();
      this.emit("click", { originalEvent: event, latlng: this.getLatLng() });
    }));
    this._unsub.push(listen(this.el, "pointerenter", (event) => {
      this.emit("mouseover", { originalEvent: event, latlng: this.getLatLng() });
    }));
    this._unsub.push(listen(this.el, "pointerleave", (event) => {
      this.emit("mouseout", { originalEvent: event, latlng: this.getLatLng() });
    }));
    if (this.options.draggable) this.#enableDrag();
    this.render();
  }

  override onRemove(): void {
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.el?.remove();
    this.el = null;
    super.onRemove();
  }

  setLatLng(position: LatLngLike): this {
    this.position = latLng(position);
    this.render();
    return this;
  }

  getLatLng(): LatLng {
    return this.position.clone();
  }

  setIcon(value: MarkerIcon | null): this {
    this.options.icon = value;
    this.#setContent();
    this.render();
    return this;
  }

  getIcon(): MarkerIcon | null {
    return this.options.icon;
  }

  setOpacity(opacity: number): this {
    this.options.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.el) this.el.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndexOffset(offset: number): this {
    this.options.zIndexOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    this.render();
    return this;
  }

  override render(): void {
    if (!this.map || !this.el) return;
    const projected = this.map.latLngToLayerPoint(this.position);
    const anchor = this.options.icon?.getAnchor() ?? { x: this.options.anchor[0], y: this.options.anchor[1] };
    this.el.style.zIndex = String(Math.round(projected.y) + this.options.zIndexOffset);
    setTransform(this.el, projected.x - anchor.x, projected.y - anchor.y);
  }

  #setContent(): void {
    if (!this.el) return;
    if (this.options.icon) {
      this.iconElement = this.options.icon.createIcon(this.iconElement);
      this.shadowElement = this.options.icon.createShadow(this.shadowElement);
      const size = this.options.icon.getSize();
      this.el.style.width = `${size.x}px`;
      this.el.style.height = `${size.y}px`;
      this.el.classList.add("oh-marker-custom");
      this.el.replaceChildren(...[this.shadowElement, this.iconElement].filter((value): value is HTMLElement => Boolean(value)));
      return;
    }
    this.iconElement = null;
    this.shadowElement = null;
    this.el.style.width = "";
    this.el.style.height = "";
    this.el.classList.remove("oh-marker-custom");
    this.el.replaceChildren();
    const content = this.options.content ?? this.options.html;
    if (typeof Node !== "undefined" && content instanceof Node) {
      this.el.replaceChildren(content);
      return;
    }
    if (content !== null && content !== undefined && content !== "") {
      this.el.textContent = String(content);
      return;
    }
    createEl("span", "oh-marker-pin", this.el);
  }

  #enableDrag(): void {
    if (!this.el) return;
    let active = false;
    const move = (event: PointerEvent): void => {
      if (!active || !this.map) return;
      const rect = this.map.container.getBoundingClientRect();
      this.position = this.map.containerPointToLatLng({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      this.render();
      this.emit("drag", { latlng: this.getLatLng() });
    };
    const up = (): void => {
      if (!active) return;
      active = false;
      this.el?.classList.remove("oh-marker-dragging");
      this.emit("dragend", { latlng: this.getLatLng() });
    };
    this._unsub.push(listen(this.el, "pointerdown", (event) => {
      event.stopPropagation();
      active = true;
      this.el?.setPointerCapture(event.pointerId);
      this.el?.classList.add("oh-marker-dragging");
      this.emit("dragstart", { latlng: this.getLatLng() });
    }));
    this._unsub.push(listen(this.el, "pointermove", move));
    this._unsub.push(listen(this.el, "pointerup", up));
    this._unsub.push(listen(this.el, "pointercancel", up));
  }
}

export function marker(position: LatLngLike, options?: MarkerOptions): Marker {
  return new Marker(position, options);
}
