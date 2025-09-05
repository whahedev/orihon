import { createEl, listen } from "../dom.js";
import type { OrihonEvent } from "../events.js";
import { LatLng, Point, latLng, point, type LatLngLike, type PointLike } from "../geo.js";
import { Layer, registerOverlayFactories, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { resolveLocale, type LocaleInput } from "../ui/locale.js";

export interface OverlayContentContext {
  overlay: DivOverlay;
  map: Orihon | null;
  latlng: LatLng | null;
  source?: unknown;
  event?: OrihonEvent;
  data?: unknown;
}

export interface OverlayMountable {
  mount(
    container: HTMLElement,
    context: OverlayContentContext
  ): void | (() => void) | { destroy(): void } | Promise<void | (() => void) | { destroy(): void }>;
  unmount?(container: HTMLElement, context: OverlayContentContext): void;
}

export type OverlayRenderable = string | number | Node | OverlayMountable | null | undefined;
export type OverlayContentFactory = (
  context: OverlayContentContext
) => OverlayRenderable | Promise<OverlayRenderable>;
export type OverlayContent = OverlayRenderable | OverlayContentFactory;

export interface DivOverlayOptions extends LayerOptions {
  className?: string;
  offset?: PointLike;
}

interface ResolvedDivOverlayOptions extends LayerOptions {
  pane: string;
  className: string;
  offset: Point;
}

export class DivOverlay<TOptions extends ResolvedDivOverlayOptions = ResolvedDivOverlayOptions> extends Layer<TOptions> {
  container: HTMLDivElement | null = null;
  contentNode: HTMLDivElement | null = null;
  protected content: OverlayContent;
  protected readonly _unsub: Array<() => void> = [];
  protected position: LatLng | null = null;
  protected contentContext: Pick<OverlayContentContext, "source" | "event" | "data"> = {};
  private _contentCleanup: (() => void) | null = null;
  private _contentGeneration = 0;

  constructor(content: OverlayContent, options: DivOverlayOptions = {}) {
    super({
      pane: "overlay",
      className: "",
      ...options,
      offset: point(options.offset ?? [0, 0])
    } as TOptions);
    this.content = content;
  }

  setLatLng(value: LatLngLike): this {
    this.position = latLng(value);
    this.render();
    return this;
  }

  getLatLng(): LatLng | null {
    return this.position?.clone() ?? null;
  }

  setContent(content: OverlayContent): this {
    this.content = content;
    this._renderContent();
    return this;
  }

  getContent(): OverlayContent {
    return this.content;
  }

  setContentContext(context: Pick<OverlayContentContext, "source" | "event" | "data">): this {
    this.contentContext = { ...context };
    this._renderContent();
    return this;
  }

  openOn(map: Orihon): this {
    map.addLayer(this);
    return this;
  }

  close(): this {
    return this.remove();
  }

  isOpen(): boolean {
    return Boolean(this.map?.hasLayer(this));
  }

  bringToFront(): this {
    if (this.container?.parentElement) this.container.parentElement.appendChild(this.container);
    return this;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = map.getPane(this.options.pane) ?? map.createPane(this.options.pane);
    this.container = createEl("div", this.options.className, pane);
    this.contentNode = createEl("div", "oh-div-overlay-content", this.container);
    const stop = (event: Event): void => event.stopPropagation();
    this._unsub.push(listen(this.container, "pointerdown", stop));
    this._unsub.push(listen(this.container, "dblclick", stop));
    this._unsub.push(listen(this.container, "wheel", stop, { passive: true }));
    this._renderContent();
    this.render();
  }

  override onRemove(): void {
    this.#disposeContent();
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.container?.remove();
    this.container = null;
    this.contentNode = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.container || !this.position) return;
    const projected = this.map.latLngToLayerPoint(this.position);
    this.container.style.left = `${projected.x + this.options.offset.x}px`;
    this.container.style.top = `${projected.y + this.options.offset.y}px`;
  }

  protected _renderContent(): void {
    if (!this.contentNode) return;
    const generation = ++this._contentGeneration;
    this.#disposeContent(false);
    this.contentNode.replaceChildren();
    this.contentNode.removeAttribute("aria-busy");
    const context = this.#resolvedContentContext();
    let result: OverlayRenderable | Promise<OverlayRenderable>;
    try {
      result = typeof this.content === "function" ? this.content(context) : this.content;
    } catch (error) {
      this.emit("contenterror", { error });
      return;
    }
    if (isPromiseLike(result)) {
      this.contentNode.setAttribute("aria-busy", "true");
      void result.then((resolved) => {
        if (generation !== this._contentGeneration || !this.contentNode) return;
        this.contentNode.removeAttribute("aria-busy");
        this.#mountContent(resolved, context, generation);
        this.render();
      }).catch((error: unknown) => {
        if (generation !== this._contentGeneration || !this.contentNode) return;
        this.contentNode.removeAttribute("aria-busy");
        this.emit("contenterror", { error });
      });
      return;
    }
    this.#mountContent(result, context, generation);
  }

  #resolvedContentContext(): OverlayContentContext {
    return {
      overlay: this,
      map: this.map,
      latlng: this.position?.clone() ?? null,
      ...this.contentContext
    };
  }

  #mountContent(value: OverlayRenderable, context: OverlayContentContext, generation: number): void {
    const container = this.contentNode;
    if (!container || generation !== this._contentGeneration || value === null || value === undefined) return;
    if (typeof Node !== "undefined" && value instanceof Node) {
      container.replaceChildren(value);
      return;
    }
    if (isMountable(value)) {
      const finalize = (result: void | (() => void) | { destroy(): void }): void => {
        const cleanup = typeof result === "function"
          ? result
          : result && typeof result.destroy === "function"
            ? () => result.destroy()
            : null;
        const dispose = (): void => {
          cleanup?.();
          value.unmount?.(container, context);
        };
        if (generation !== this._contentGeneration || this.contentNode !== container) dispose();
        else this._contentCleanup = dispose;
      };
      try {
        const mounted = value.mount(container, context);
        if (isPromiseLike(mounted)) void mounted.then(finalize).catch((error: unknown) => this.emit("contenterror", { error }));
        else finalize(mounted);
      } catch (error) {
        this.emit("contenterror", { error });
      }
      return;
    }
    container.textContent = String(value);
  }

  #disposeContent(invalidate = true): void {
    if (invalidate) this._contentGeneration += 1;
    this._contentCleanup?.();
    this._contentCleanup = null;
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function isMountable(value: unknown): value is OverlayMountable {
  return Boolean(value && typeof (value as { mount?: unknown }).mount === "function");
}

export interface PopupOptions extends DivOverlayOptions {
  closeButton?: boolean;
  autoClose?: boolean;
  closeOnClick?: boolean;
  autoPan?: boolean;
  autoPanPadding?: PointLike;
  keepInView?: boolean;
  ariaLabel?: string;
  locale?: LocaleInput;
}

interface ResolvedPopupOptions extends ResolvedDivOverlayOptions {
  closeButton: boolean;
  autoClose: boolean;
  closeOnClick: boolean;
  autoPan: boolean;
  autoPanPadding: Point;
  keepInView: boolean;
  ariaLabel: string;
  locale?: LocaleInput;
}

const activePopups = new WeakMap<Orihon, Popup>();

export class Popup extends DivOverlay<ResolvedPopupOptions> {
  private _mapClick: (() => void) | null = null;
  private _autoPanFrame = 0;

  constructor(content: OverlayContent, options: PopupOptions = {}) {
    super(content, {
      pane: "popup",
      className: "oh-popup",
      offset: [0, -12],
      closeButton: true,
      autoClose: true,
      closeOnClick: true,
      autoPan: true,
      autoPanPadding: [16, 16],
      keepInView: false,
      ariaLabel: "",
      ...options
    } as PopupOptions);
    Object.assign(this.options, {
      closeButton: options.closeButton ?? true,
      autoClose: options.autoClose ?? true,
      closeOnClick: options.closeOnClick ?? true,
      autoPan: options.autoPan ?? true,
      autoPanPadding: point(options.autoPanPadding ?? [16, 16]),
      keepInView: options.keepInView ?? false,
      ariaLabel: options.ariaLabel ?? "",
      locale: options.locale
    });
  }

  override onAdd(map: Orihon): void {
    if (this.options.autoClose) {
      const active = activePopups.get(map);
      if (active && active !== this) active.close();
      activePopups.set(map, this);
    }
    super.onAdd(map);
    this.container?.classList.add("oh-popup");
    this.container?.setAttribute("role", "dialog");
    this.container?.setAttribute("aria-live", "polite");
    if (this.options.ariaLabel) this.container?.setAttribute("aria-label", this.options.ariaLabel);
    const locale = resolveLocale(this.options.locale ?? map.locale);
    if (this.options.closeButton && this.container) {
      const button = createEl("button", "oh-popup-close", this.container);
      button.type = "button";
      button.title = locale.closePopup;
      button.setAttribute("aria-label", locale.closePopup);
      button.textContent = "×";
      this._unsub.push(listen(button, "click", () => this.close()));
    }
    if (this.options.closeOnClick) {
      const close = (): void => { this.close(); };
      map.on("click", close);
      this._mapClick = () => map.off("click", close);
    }
    if (this.options.keepInView) {
      const adjust = (): void => this.#scheduleAutoPan();
      map.on("moveend", adjust);
      map.on("resize", adjust);
      this._unsub.push(() => map.off("moveend", adjust));
      this._unsub.push(() => map.off("resize", adjust));
    }
    this.#scheduleAutoPan();
    this.emit("open", { map }, false);
    map.emit("popupopen", { popup: this });
  }

  override onRemove(): void {
    const map = this.map;
    if (this._autoPanFrame) cancelAnimationFrame(this._autoPanFrame);
    this._autoPanFrame = 0;
    this._mapClick?.();
    this._mapClick = null;
    if (map && activePopups.get(map) === this) activePopups.delete(map);
    super.onRemove();
    this.emit("close", { map }, false);
    map?.emit("popupclose", { popup: this });
  }

  override setContent(content: OverlayContent): this {
    super.setContent(content);
    this.#scheduleAutoPan();
    return this;
  }

  override setLatLng(value: LatLngLike): this {
    super.setLatLng(value);
    this.#scheduleAutoPan();
    return this;
  }

  #scheduleAutoPan(): void {
    if (!this.options.autoPan || !this.map || !this.container || this._autoPanFrame) return;
    this._autoPanFrame = requestAnimationFrame(() => {
      this._autoPanFrame = 0;
      this.#adjustPan();
    });
  }

  #adjustPan(): void {
    if (!this.map || !this.container) return;
    const mapRect = this.map.container.getBoundingClientRect();
    const popupRect = this.container.getBoundingClientRect();
    const padding = this.options.autoPanPadding;
    const minX = mapRect.left + padding.x;
    const maxX = mapRect.right - padding.x;
    const minY = mapRect.top + padding.y;
    const maxY = mapRect.bottom - padding.y;
    let x = 0;
    let y = 0;
    if (popupRect.width > maxX - minX) {
      x = (popupRect.left + popupRect.right - minX - maxX) / 2;
    } else if (popupRect.left < minX) x = popupRect.left - minX;
    else if (popupRect.right > maxX) x = popupRect.right - maxX;
    if (popupRect.height > maxY - minY) {
      y = (popupRect.top + popupRect.bottom - minY - maxY) / 2;
    } else if (popupRect.top < minY) y = popupRect.top - minY;
    else if (popupRect.bottom > maxY) y = popupRect.bottom - maxY;
    if (Math.abs(x) < 1) x = 0;
    if (Math.abs(y) < 1) y = 0;
    if (x || y) this.map.panBy([x, y]);
  }
}

export interface TooltipOptions extends DivOverlayOptions {
  permanent?: boolean;
  direction?: "top" | "right" | "bottom" | "left" | "center";
  opacity?: number;
}

interface ResolvedTooltipOptions extends ResolvedDivOverlayOptions {
  permanent: boolean;
  direction: "top" | "right" | "bottom" | "left" | "center";
  opacity: number;
}

export class Tooltip extends DivOverlay<ResolvedTooltipOptions> {
  constructor(content: OverlayContent, options: TooltipOptions = {}) {
    super(content, {
      pane: "tooltip",
      className: "oh-tooltip",
      offset: [0, -10],
      permanent: false,
      direction: "top",
      opacity: 0.94,
      ...options
    } as TooltipOptions);
    Object.assign(this.options, {
      permanent: options.permanent ?? false,
      direction: options.direction ?? "top",
      opacity: options.opacity ?? 0.94
    });
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.container?.classList.add("oh-tooltip", `oh-tooltip-${this.options.direction}`);
    this.container?.setAttribute("role", "tooltip");
    if (this.container) this.container.style.opacity = String(this.options.opacity);
    this.emit("open", { map }, false);
    map.emit("tooltipopen", { tooltip: this });
  }

  override onRemove(): void {
    const map = this.map;
    super.onRemove();
    this.emit("close", { map }, false);
    map?.emit("tooltipclose", { tooltip: this });
  }
}

export function popup(content: OverlayContent, options?: PopupOptions): Popup {
  return new Popup(content, options);
}

export function tooltip(content: OverlayContent, options?: TooltipOptions): Tooltip {
  return new Tooltip(content, options);
}

registerOverlayFactories(popup, tooltip);
