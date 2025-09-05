import { listen } from "../dom.js";
import { LatLngBounds, latLngBounds, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions } from "./div-overlay.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export type SVGOverlayContent = SVGElement | string;

export interface SVGOverlayOptions extends LayerOptions {
  opacity?: number;
  className?: string;
  interactive?: boolean;
  zIndex?: number;
}

interface ResolvedSVGOverlayOptions extends LayerOptions {
  pane: string;
  attribution: string;
  opacity: number;
  className: string;
  interactive: boolean;
  zIndex: number;
}

export class SVGOverlay extends Layer<ResolvedSVGOverlayOptions> {
  content: SVGOverlayContent;
  overlayBounds: LatLngBounds;
  element: SVGElement | null = null;
  readonly _unsub: Array<() => void> = [];
  private _interactiveUnsub: (() => void) | null = null;

  constructor(content: SVGOverlayContent, value: LatLngBoundsLike, options: SVGOverlayOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      opacity: 1,
      className: "",
      interactive: false,
      zIndex: 0,
      ...options
    } as ResolvedSVGOverlayOptions);
    this.content = content;
    this.overlayBounds = new LatLngBounds(latLngBounds(value));
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.element = this.#createElement();
    this.element.classList.add("oh-svg-overlay");
    if (this.options.className) this.element.classList.add(...this.options.className.split(/\s+/).filter(Boolean));
    this.element.style.opacity = String(this.options.opacity);
    this.element.style.zIndex = String(this.options.zIndex);
    pane.appendChild(this.element);
    this.#syncInteractive();
    this.render();
  }

  override onRemove(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.element?.remove();
    this.element = null;
    super.onRemove();
  }

  setContent(content: SVGOverlayContent): this {
    this.content = content;
    if (!this.map || !this.element) return this;
    const parent = this.element.parentElement;
    this.element.remove();
    this.element = this.#createElement();
    this.element.classList.add("oh-svg-overlay");
    if (this.options.className) this.element.classList.add(...this.options.className.split(/\s+/).filter(Boolean));
    this.element.style.opacity = String(this.options.opacity);
    this.element.style.zIndex = String(this.options.zIndex);
    parent?.appendChild(this.element);
    this.#syncInteractive();
    this.render();
    return this;
  }

  setBounds(value: LatLngBoundsLike): this {
    this.overlayBounds = new LatLngBounds(latLngBounds(value));
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.options.interactive = true;
    this.#syncInteractive();
    return super.bindPopup(content, options);
  }

  getBounds(): LatLngBounds {
    return new LatLngBounds(this.overlayBounds);
  }

  setOpacity(opacity: number): this {
    this.options.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.element) this.element.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndex(zIndex: number): this {
    this.options.zIndex = Number(zIndex);
    if (this.element) this.element.style.zIndex = String(this.options.zIndex);
    return this;
  }

  bringToFront(): this { return this.#moveToEdge(true); }
  bringToBack(): this { return this.#moveToEdge(false); }
  getElement(): SVGElement | null { return this.element; }

  override render(): void {
    if (!this.map || !this.element) return;
    const northWest = this.map.latLngToLayerPoint(this.overlayBounds.getNorthWest());
    const southEast = this.map.latLngToLayerPoint(this.overlayBounds.getSouthEast());
    this.element.style.left = `${northWest.x}px`;
    this.element.style.top = `${northWest.y}px`;
    this.element.style.width = `${Math.max(0, southEast.x - northWest.x)}px`;
    this.element.style.height = `${Math.max(0, southEast.y - northWest.y)}px`;
    this.element.setAttribute("preserveAspectRatio", this.element.getAttribute("preserveAspectRatio") || "none");
  }

  #createElement(): SVGElement {
    if (typeof this.content !== "string") return this.content;
    const parsed = new DOMParser().parseFromString(this.content, "image/svg+xml").documentElement;
    if (parsed.namespaceURI === SVG_NS && parsed instanceof SVGElement) {
      return sanitizeSvgElement(parsed);
    }
    const fallback = document.createElementNS(SVG_NS, "svg");
    fallback.setAttribute("viewBox", "0 0 1 1");
    return fallback;
  }

  #syncInteractive(): void {
    this._interactiveUnsub?.();
    this._interactiveUnsub = null;
    if (!this.element || !this.map || !this.options.interactive) return;
    this.element.classList.add("oh-interactive");
    this._interactiveUnsub = listen(this.element, "click", (event) => {
      event.stopPropagation();
      const rect = this.map!.container.getBoundingClientRect();
      this.emit("click", {
        originalEvent: event,
        latlng: this.map!.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top])
      });
    });
  }

  #moveToEdge(front: boolean): this {
    const element = this.element;
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

export function svgOverlay(content: SVGOverlayContent, value: LatLngBoundsLike, options?: SVGOverlayOptions): SVGOverlay {
  return new SVGOverlay(content, value, options);
}

const DANGEROUS_SVG_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);

/** Strip scripts, event handlers and javascript: URLs from parsed SVG strings before DOM insertion. */
export function sanitizeSvgElement(root: SVGElement): SVGElement {
  const scrubAttributes = (element: Element): void => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || /^(?:javascript|data|vbscript):/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  };
  scrubAttributes(root);
  const remove: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Element) {
      if (DANGEROUS_SVG_TAGS.has(node.tagName.toLowerCase())) remove.push(node);
      else scrubAttributes(node);
    }
    node = walker.nextNode();
  }
  for (const element of remove) element.remove();
  return root;
}
