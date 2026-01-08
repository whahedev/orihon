import { Point, point, type PointLike } from "../geo.js";

export interface IconOptions {
  iconUrl: string;
  iconRetinaUrl?: string;
  iconSize?: PointLike;
  iconAnchor?: PointLike;
  shadowUrl?: string;
  shadowRetinaUrl?: string;
  shadowSize?: PointLike;
  shadowAnchor?: PointLike;
  className?: string;
  alt?: string;
}

interface ResolvedIconOptions {
  iconUrl: string;
  iconRetinaUrl: string;
  iconSize: Point;
  iconAnchor: Point;
  shadowUrl: string;
  shadowRetinaUrl: string;
  shadowSize: Point;
  shadowAnchor: Point;
  className: string;
  alt: string;
}

export class Icon {
  readonly options: ResolvedIconOptions;

  constructor(options: IconOptions) {
    if (!options?.iconUrl) throw new TypeError("Icon iconUrl is required");
    const iconSize = point(options.iconSize ?? [24, 36]);
    this.options = {
      iconUrl: options.iconUrl,
      iconRetinaUrl: options.iconRetinaUrl ?? "",
      iconSize,
      iconAnchor: point(options.iconAnchor ?? [iconSize.x / 2, iconSize.y]),
      shadowUrl: options.shadowUrl ?? "",
      shadowRetinaUrl: options.shadowRetinaUrl ?? "",
      shadowSize: point(options.shadowSize ?? iconSize),
      shadowAnchor: point(options.shadowAnchor ?? [iconSize.x / 2, iconSize.y]),
      className: options.className ?? "",
      alt: options.alt ?? "Map marker"
    };
  }

  createIcon(oldIcon?: HTMLElement | null): HTMLImageElement {
    const image = oldIcon instanceof HTMLImageElement ? oldIcon : document.createElement("img");
    const retina = typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1;
    image.src = retina && this.options.iconRetinaUrl ? this.options.iconRetinaUrl : this.options.iconUrl;
    image.alt = this.options.alt;
    image.className = `oh-marker-icon ${this.options.className}`.trim();
    image.style.width = `${this.options.iconSize.x}px`;
    image.style.height = `${this.options.iconSize.y}px`;
    image.draggable = false;
    return image;
  }

  createShadow(oldShadow?: HTMLElement | null): HTMLImageElement | null {
    if (!this.options.shadowUrl) return null;
    const image = oldShadow instanceof HTMLImageElement ? oldShadow : document.createElement("img");
    const retina = typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1;
    image.src = retina && this.options.shadowRetinaUrl ? this.options.shadowRetinaUrl : this.options.shadowUrl;
    image.alt = "";
    image.className = "oh-marker-shadow";
    image.style.width = `${this.options.shadowSize.x}px`;
    image.style.height = `${this.options.shadowSize.y}px`;
    image.style.left = `${this.options.iconAnchor.x - this.options.shadowAnchor.x}px`;
    image.style.top = `${this.options.iconAnchor.y - this.options.shadowAnchor.y}px`;
    image.draggable = false;
    return image;
  }

  getAnchor(): Point {
    return this.options.iconAnchor.clone();
  }

  getSize(): Point {
    return this.options.iconSize.clone();
  }
}

export interface DivIconOptions {
  content?: string | number | Node;
  iconSize?: PointLike;
  iconAnchor?: PointLike;
  className?: string;
}

interface ResolvedDivIconOptions {
  content: string | number | Node;
  iconSize: Point;
  iconAnchor: Point;
  className: string;
}

export class DivIcon {
  readonly options: ResolvedDivIconOptions;

  constructor(options: DivIconOptions = {}) {
    const iconSize = point(options.iconSize ?? [32, 32]);
    this.options = {
      content: options.content ?? "",
      iconSize,
      iconAnchor: point(options.iconAnchor ?? [iconSize.x / 2, iconSize.y / 2]),
      className: options.className ?? ""
    };
  }

  createIcon(oldIcon?: HTMLElement | null): HTMLDivElement {
    const element = oldIcon instanceof HTMLDivElement ? oldIcon : document.createElement("div");
    element.className = `oh-div-icon ${this.options.className}`.trim();
    element.style.width = `${this.options.iconSize.x}px`;
    element.style.height = `${this.options.iconSize.y}px`;
    if (typeof Node !== "undefined" && this.options.content instanceof Node) {
      element.replaceChildren(this.options.content.cloneNode(true));
    } else {
      element.textContent = String(this.options.content);
    }
    return element;
  }

  createShadow(): null {
    return null;
  }

  getAnchor(): Point {
    return this.options.iconAnchor.clone();
  }

  getSize(): Point {
    return this.options.iconSize.clone();
  }
}

export type MarkerIcon = Icon | DivIcon;

export function icon(options: IconOptions): Icon;
export function icon(options?: DivIconOptions): DivIcon;
export function icon(options: IconOptions | DivIconOptions = {}): Icon | DivIcon {
  return "iconUrl" in options ? new Icon(options) : new DivIcon(options);
}

export function divIcon(options?: DivIconOptions): DivIcon {
  return new DivIcon(options);
}
