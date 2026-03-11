import { createEl, listen } from "../dom.js";
import type { EventFor, EventHandler } from "../events.js";
import type { GeoJSONData, GeoJSONFeatureCollection } from "../layers/geojson.js";
import type { ControlPosition, Orihon } from "../map.js";
import { Control, type ControlOptions } from "../ui/control.js";
import type { LocaleName } from "../ui/locale.js";
import { DrawHandler, type DrawEventMap, type DrawHandlerOptions, type DrawMode } from "./handler.js";
import { drawLocaleFromMapLabel, resolveDrawLocale, type DrawLocale } from "./locale.js";
import { abortError } from "../services/abortable-operation.js";

export interface DrawControlOptions extends DrawHandlerOptions, ControlOptions {}

const MODE_LABELS: Record<Exclude<DrawMode, "off">, keyof DrawLocale> = {
  point: "drawPoint",
  polyline: "drawLine",
  polygon: "drawPolygon",
  rectangle: "drawRectangle",
  circle: "drawCircle",
  edit: "drawEdit",
  delete: "drawDelete"
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string>
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

/** Create the built-in, presentation-only icon for a drawing mode. */
export function createDrawModeIcon(mode: Exclude<DrawMode, "off">): SVGSVGElement {
  const icon = svgElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false"
  });

  if (mode === "point") {
    icon.append(svgElement("circle", { cx: "12", cy: "12", r: "4", fill: "currentColor", stroke: "none" }));
  } else if (mode === "polyline") {
    icon.append(svgElement("polyline", { points: "3,18 8,7 14,14 21,4" }));
    for (const [cx, cy] of [["3", "18"], ["8", "7"], ["14", "14"], ["21", "4"]]) {
      icon.append(svgElement("circle", { cx, cy, r: "1.5", fill: "currentColor", stroke: "none" }));
    }
  } else if (mode === "polygon") {
    icon.append(svgElement("polygon", { points: "4,18 8,5 19,8 20,19 4,18" }));
  } else if (mode === "rectangle") {
    icon.append(svgElement("rect", { x: "4", y: "5", width: "16", height: "14", rx: "1" }));
  } else if (mode === "circle") {
    icon.append(svgElement("circle", { cx: "12", cy: "12", r: "8" }));
  } else if (mode === "edit") {
    icon.append(svgElement("path", { d: "M4 20l4.5-1 11-11-3.5-3.5-11 11L4 20zM14.5 6l3.5 3.5" }));
  } else {
    icon.append(
      svgElement("path", { d: "M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14" })
    );
  }

  return icon;
}

export class DrawControl extends Control<DrawControlOptions> {
  readonly handler: DrawHandler;
  readonly featureGroup;
  private buttons = new Map<DrawMode, HTMLButtonElement>();
  private actionButtons = new Map<"drawFinish" | "drawCancel" | "drawUndo" | "drawRedo", HTMLButtonElement>();

  constructor(options: DrawControlOptions = {}) {
    super({ position: "top-left", className: "oh-draw-control", ...options });
    this.handler = new DrawHandler(options);
    this.featureGroup = this.handler.featureGroup;
  }

  get isDestroyed(): boolean { return this.handler.isDestroyed; }

  #assertAlive(): void {
    if (this.isDestroyed) throw abortError("DrawControl was destroyed");
  }

  override addTo(map: Orihon): this {
    this.#assertAlive();
    if (map._destroyed) throw abortError("Cannot attach DrawControl to a destroyed map");
    return super.addTo(map);
  }

  override onAdd(map: Orihon): void {
    this.#assertAlive();
    if (map._destroyed) throw abortError("Cannot attach DrawControl to a destroyed map");
    if (this.map && this.map !== map) this.remove();
    this.#assertAlive();
    super.onAdd(map);
    this.handler.addTo(map);
    const toolbar = createEl("div", "oh-draw-toolbar", this.el!);
    for (const mode of this.handler.options.modes) {
      if (mode === "off") continue;
      const button = createEl("button", `oh-control-button oh-draw-${mode}`, toolbar);
      button.type = "button";
      button.append(createDrawModeIcon(mode));
      this.buttons.set(mode, button);
      this._unsub.push(listen(button, "click", () => this.setMode(this.handler.mode === mode ? "off" : mode)));
    }
    const actions = createEl("div", "oh-draw-actions", this.el!);
    this.#action(actions, "✓", "drawFinish", () => this.finish());
    this.#action(actions, "×", "drawCancel", () => this.cancel());
    this.#action(actions, "↶", "drawUndo", () => this.undo());
    this.#action(actions, "↷", "drawRedo", () => this.redo());
    const modeChange = (): void => this.render();
    this.handler.on("modechange", modeChange);
    this.handler.on("undo", modeChange);
    this.handler.on("redo", modeChange);
    this.handler.on("drawcomplete", modeChange);
    this.handler.on("editcomplete", modeChange);
    this.handler.on("deletecomplete", modeChange);
    this._unsub.push(
      () => this.handler.off("modechange", modeChange),
      () => this.handler.off("undo", modeChange),
      () => this.handler.off("redo", modeChange),
      () => this.handler.off("drawcomplete", modeChange),
      () => this.handler.off("editcomplete", modeChange),
      () => this.handler.off("deletecomplete", modeChange)
    );
    this.render();
  }

  override onRemove(): void {
    try {
      this.handler.remove();
    } finally {
      this.buttons.clear();
      this.actionButtons.clear();
      super.onRemove();
    }
  }

  override remove(): this {
    if (arguments.length) throw new TypeError("Draw remove() no longer accepts options. Clear featureGroup explicitly or use destroy().");
    if (this.map) super.remove();
    else this.handler.remove();
    return this;
  }

  destroy(): this {
    this.handler.destroy();
    this.remove();
    return this;
  }

  override setPosition(position: ControlPosition): this {
    this.#assertAlive();
    return super.setPosition(position);
  }

  setMode(mode: DrawMode): this { this.handler.setMode(mode); return this; }
  on<K extends string>(type: K, handler: EventHandler<EventFor<DrawEventMap, NoInfer<K>, DrawHandler>>): this { this.handler.on(type, handler); return this; }
  once<K extends string>(type: K, handler: EventHandler<EventFor<DrawEventMap, NoInfer<K>, DrawHandler>>): this { this.handler.once(type, handler); return this; }
  off(): this;
  off<K extends string>(type: K, handler?: EventHandler<EventFor<DrawEventMap, NoInfer<K>, DrawHandler>>): this;
  off(type?: string, handler?: EventHandler<any>): this {
    if (type === undefined) this.handler.off();
    else this.handler.off(type, handler);
    return this;
  }
  finish(): this { this.handler.finish(); return this; }
  cancel(): this { this.handler.cancel(); return this; }
  undo(): this { this.handler.undo(); return this; }
  redo(): this { this.handler.redo(); return this; }
  toGeoJSON(): GeoJSONFeatureCollection { return this.handler.toGeoJSON(); }
  loadData(data: GeoJSONData): this { this.handler.loadData(data); return this; }

  override render(): void {
    if (this.isDestroyed) return;
    const labels = this.#labels();
    for (const [mode, button] of this.buttons) {
      const label = labels[MODE_LABELS[mode as Exclude<DrawMode, "off">]];
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(this.handler.mode === mode));
    }
    for (const [key, button] of this.actionButtons) {
      button.title = labels[key];
      button.setAttribute("aria-label", labels[key]);
    }
  }

  #labels(): DrawLocale {
    if (typeof this.options.locale === "string") return resolveDrawLocale(this.options.locale as LocaleName);
    return drawLocaleFromMapLabel(this.locale.mapLabel);
  }

  #action(
    parent: HTMLElement,
    text: string,
    label: "drawFinish" | "drawCancel" | "drawUndo" | "drawRedo",
    action: () => void
  ): void {
    const button = createEl("button", "oh-control-button", parent);
    button.type = "button";
    button.textContent = text;
    this.actionButtons.set(label, button);
    this._unsub.push(listen(button, "click", action));
  }
}

export function drawControl(options?: DrawControlOptions): DrawControl {
  return new DrawControl(options);
}
