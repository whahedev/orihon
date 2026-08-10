import { createMap, type Orihon, type MapOptions } from "../map.js";

export interface MapAdapter {
  map: Orihon;
  update(options: Partial<MapOptions>): Orihon;
  destroy(): void;
}

export function createMapAdapter(container: HTMLElement | string, options: MapOptions = {}): MapAdapter {
  const map = createMap(container, options);
  return {
    map,
    update(next: Partial<MapOptions>) {
      if (next.center || typeof next.zoom === "number") map.setView(next.center ?? map.getCenter(), next.zoom ?? map.getZoom());
      for (const [name, enabled] of Object.entries(next.behaviors ?? {})) {
        map.behaviors.toggle(name as never, Boolean(enabled));
      }
      return map;
    },
    destroy() {
      map.remove();
    }
  };
}

export interface OrihonElementOptions {
  tagName?: string;
}

export function defineOrihonElement(options: OrihonElementOptions = {}): CustomElementConstructor | null {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return null;
  const tagName = options.tagName ?? "orihon-map";
  const existing = customElements.get(tagName);
  if (existing) return existing;
  class OrihonElement extends HTMLElement {
    map: Orihon | null = null;

    connectedCallback(): void {
      if (this.map) return;
      if (!this.style.display) this.style.display = "block";
      if (!this.style.minHeight) this.style.minHeight = "320px";
      this.map = createMap(this, {
        center: [
          Number(this.getAttribute("lat") ?? 0),
          Number(this.getAttribute("lng") ?? 0)
        ],
        zoom: Number(this.getAttribute("zoom") ?? 2),
        controls: this.getAttribute("controls") !== "false"
      });
    }

    disconnectedCallback(): void {
      this.map?.remove();
      this.map = null;
    }
  }
  customElements.define(tagName, OrihonElement);
  return OrihonElement;
}
