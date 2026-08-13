import type { Orihon } from "../map.js";

export interface ExportPngOptions {
  pixelRatio?: number;
  includeControls?: boolean;
}

export interface PrintMapOptions extends ExportPngOptions {
  title?: string;
}

export async function exportMapPng(map: Orihon, options: ExportPngOptions = {}): Promise<Blob> {
  if (typeof document === "undefined") throw new Error("Map export requires a browser document");
  const requestedRatio = Number(options.pixelRatio ?? 1);
  if (!Number.isFinite(requestedRatio)) throw new RangeError("pixelRatio must be a finite number");
  const ratio = Math.max(0.25, Math.min(8, requestedRatio));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(map.size.width * ratio));
  canvas.height = Math.max(1, Math.round(map.size.height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.scale(ratio, ratio);
  const mapRect = map.container.getBoundingClientRect();
  const background = getComputedStyle(map.container).backgroundColor;
  if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, map.size.width, map.size.height);
  }

  const roots: Element[] = [map.viewport];
  if (options.includeControls && map.panes.control) roots.push(map.panes.control);
  for (const root of roots) {
    for (const element of root.querySelectorAll("img,canvas,svg")) {
      if (element instanceof HTMLImageElement) await drawImageElement(ctx, element, mapRect);
      else if (element instanceof HTMLCanvasElement) drawCanvasElement(ctx, element, mapRect);
      else if (element instanceof SVGSVGElement) await drawSvgElement(ctx, element, mapRect);
    }
  }
  if (options.includeControls && map.panes.control) drawControlText(ctx, map.panes.control, mapRect);

  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed; a cross-origin image may have tainted the canvas")), "image/png");
    } catch (error) {
      reject(error);
    }
  });
}

export async function printMap(map: Orihon, options: PrintMapOptions = {}): Promise<void> {
  if (typeof window === "undefined") throw new Error("Map printing requires a browser window");
  const target = window.open("", "_blank");
  if (!target) throw new Error("Print window was blocked");
  let objectUrl: string | null = null;
  const releaseUrl = (): void => {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  try {
    const blob = await exportMapPng(map, options);
    objectUrl = URL.createObjectURL(blob);
    const image = target.document.createElement("img");
    image.alt = options.title ?? "Map";
    image.style.maxWidth = "100%";
    target.document.title = options.title ?? "Map";
    target.document.body.style.margin = "0";
    target.document.body.replaceChildren(image);
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to prepare map for printing"));
      image.src = objectUrl!;
    });
    target.addEventListener("afterprint", releaseUrl, { once: true });
    target.addEventListener("beforeunload", releaseUrl, { once: true });
    target.focus();
    target.print();
  } catch (error) {
    releaseUrl();
    target.close();
    throw error;
  }
}

function elementRect(element: Element, mapRect: DOMRect): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left - mapRect.left, y: rect.top - mapRect.top, width: rect.width, height: rect.height };
}

function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
}

function opacity(element: Element): number {
  let value = 1;
  for (let current: Element | null = element; current; current = current.parentElement) {
    value *= Number(getComputedStyle(current).opacity || 1);
  }
  return value;
}

async function drawImageElement(ctx: CanvasRenderingContext2D, image: HTMLImageElement, mapRect: DOMRect): Promise<void> {
  if (!visible(image) || !image.complete || !image.naturalWidth) return;
  const rect = elementRect(image, mapRect);
  if (rect.width <= 0 || rect.height <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity(image);
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawCanvasElement(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, mapRect: DOMRect): void {
  if (!visible(source) || !source.width || !source.height) return;
  const rect = elementRect(source, mapRect);
  if (rect.width <= 0 || rect.height <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity(source);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

async function drawSvgElement(ctx: CanvasRenderingContext2D, source: SVGSVGElement, mapRect: DOMRect): Promise<void> {
  if (!visible(source)) return;
  const rect = elementRect(source, mapRect);
  if (rect.width <= 0 || rect.height <= 0) return;
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll("script,foreignObject").forEach((node) => node.remove());
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to rasterize map SVG"));
      image.src = url;
    });
    ctx.save();
    ctx.globalAlpha = opacity(source);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawControlText(ctx: CanvasRenderingContext2D, root: HTMLElement, mapRect: DOMRect): void {
  const controls = root.querySelectorAll<HTMLElement>(".oh-control");
  for (const control of controls) {
    if (!visible(control)) continue;
    const rect = elementRect(control, mapRect);
    const style = getComputedStyle(control);
    if (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") {
      ctx.fillStyle = style.backgroundColor;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    for (const leaf of control.querySelectorAll<HTMLElement>("button,span,div")) {
      if (leaf.children.length || !visible(leaf)) continue;
      const text = leaf.textContent?.trim();
      if (!text) continue;
      const leafRect = elementRect(leaf, mapRect);
      const leafStyle = getComputedStyle(leaf);
      ctx.font = leafStyle.font;
      ctx.fillStyle = leafStyle.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, leafRect.x + leafRect.width / 2, leafRect.y + leafRect.height / 2, leafRect.width);
    }
  }
}
