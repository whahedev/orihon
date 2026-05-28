import type { LatLngBoundsLike } from "../geo.js";
import type { LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { MediaOverlay } from "./media-overlay.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export type SVGOverlayContent = SVGElement | string;

export interface SVGOverlayOptions extends LayerOptions {
  opacity?: number;
  className?: string;
  interactive?: boolean;
  zIndex?: number;
  rotation?: number;
}

interface ResolvedSVGOverlayOptions extends LayerOptions {
  pane: string;
  attribution: string;
  opacity: number;
  className: string;
  interactive: boolean;
  zIndex: number;
  rotation: number;
}

export class SVGOverlay extends MediaOverlay<SVGElement, ResolvedSVGOverlayOptions> {
  content: SVGOverlayContent;
  element: SVGElement | null = null;

  constructor(content: SVGOverlayContent, value: LatLngBoundsLike, options: SVGOverlayOptions = {}) {
    super(value, {
      pane: "overlay",
      attribution: "",
      opacity: 1,
      className: "",
      interactive: false,
      zIndex: 0,
      rotation: 0,
      ...options
    } as ResolvedSVGOverlayOptions);
    this.content = content;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.element = this.#createElement();
    this.attachMediaElement(this.element, "oh-svg-overlay");
  }

  protected override mediaElement(): SVGElement | null { return this.element; }
  protected override clearMediaElement(): void { this.element = null; }

  setContent(content: SVGOverlayContent): this {
    this.content = content;
    if (!this.map || !this.element) return this;
    this.resetMediaElement();
    this.element = this.#createElement();
    this.attachMediaElement(this.element, "oh-svg-overlay");
    return this;
  }

  override render(): void {
    super.render();
    if (!this.element) return;
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

}

export function svgOverlay(content: SVGOverlayContent, value: LatLngBoundsLike, options?: SVGOverlayOptions): SVGOverlay {
  return new SVGOverlay(content, value, options);
}

const DANGEROUS_SVG_TAGS = new Set(
  "script,foreignobject,iframe,object,embed,style,use,image,feimage,a,video,audio,animate,set,animatetransform,animatemotion".split(",")
);

const URL_SVG_ATTRS = new Set(["href", "xlink:href", "src", "poster"]);

export function svgTagIsDangerous(tag: string): boolean {
  return DANGEROUS_SVG_TAGS.has(tag.toLowerCase());
}

export function svgAttributeIsDangerous(name: string, value: string): boolean {
  const n = name.toLowerCase();
  const v = value.trim();
  if (n.startsWith("on") || n === "style") return true;
  if (URL_SVG_ATTRS.has(n)) return Boolean(v) && !v.startsWith("#");
  return /^(?:javascript|data|vbscript):/i.test(v);
}

/** Strip scripts, handlers, external URLs and unsafe tags from parsed SVG strings before DOM insertion. */
export function sanitizeSvgElement(root: SVGElement): SVGElement {
  const scrubAttributes = (element: Element): void => {
    for (const attribute of [...element.attributes]) {
      if (svgAttributeIsDangerous(attribute.name, attribute.value)) {
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
      if (svgTagIsDangerous(node.tagName)) remove.push(node);
      else scrubAttributes(node);
    }
    node = walker.nextNode();
  }
  for (const element of remove) element.remove();
  return root;
}
