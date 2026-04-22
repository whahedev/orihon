import type { EventHandler, OrihonEvent } from "./events.js";
import { latLng, type LatLngLike } from "./geo.js";
import { Layer, type LayerOptions } from "./layer.js";
import {
  popup,
  tooltip,
  type OverlayContent,
  type Popup,
  type PopupOptions,
  type Tooltip,
  type TooltipOptions
} from "./overlays/div-overlay.js";

interface LocatedLayer {
  getLatLng(): LatLngLike;
}

interface BoundedLayer {
  getBounds(): { getCenter(): LatLngLike; isValid?(): boolean };
}

/**
 * Layer that can carry a Popup and a Tooltip.
 *
 * This module lives above Core precisely so it can depend on the overlay implementation
 * directly: `bindPopup` calls the imported `popup()`, with no registry and no import-order
 * question about whether the capability is present. Core raster layers extend plain `Layer`
 * rather than advertising a capability that tier does not ship, which is what keeps the
 * overlay module out of the Core bundle without a runtime indirection.
 */
export class InteractiveLayer<TOptions extends LayerOptions = LayerOptions, TEvents extends object = {}> extends Layer<TOptions, TEvents> {
  protected _popup: Popup | null = null;
  protected _tooltip: Tooltip | null = null;
  private _popupHandlers: Array<[string, EventHandler]> = [];
  private _tooltipHandlers: Array<[string, EventHandler]> = [];

  bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.unbindPopup();
    this._popup = popup(content, options);
    const open: EventHandler = (event) => {
      this._popup?.setContentContext({ source: this, event, data: event.data });
      this.openPopup(this._eventLatLng(event));
    };
    const move: EventHandler = (event) => {
      const value = this._eventLatLng(event, false);
      if (value && this._popup?.isOpen()) this._popup.setLatLng(value);
    };
    const close: EventHandler = () => this.closePopup();
    this._popupHandlers = [["click", open], ["drag", move], ["remove", close]];
    for (const [type, handler] of this._popupHandlers) this.on(type, handler);
    return this;
  }

  unbindPopup(): this {
    for (const [type, handler] of this._popupHandlers) this.off(type, handler);
    this._popupHandlers = [];
    this._popup?.close();
    this._popup = null;
    return this;
  }

  openPopup(value?: LatLngLike): this {
    if (!this.map || !this._popup) return this;
    this._popup.setLatLng(value ?? this._overlayAnchor()).openOn(this.map);
    return this;
  }

  closePopup(): this {
    this._popup?.close();
    return this;
  }

  togglePopup(): this {
    return this._popup?.isOpen() ? this.closePopup() : this.openPopup();
  }

  isPopupOpen(): boolean {
    return Boolean(this._popup?.isOpen());
  }

  getPopup(): Popup | null {
    return this._popup;
  }

  bindTooltip(content: OverlayContent, options?: TooltipOptions): this {
    this.unbindTooltip();
    this._tooltip = tooltip(content, options);
    const open: EventHandler = (event) => {
      this._tooltip?.setContentContext({ source: this, event, data: event.data });
      this.openTooltip(this._eventLatLng(event));
    };
    const move: EventHandler = (event) => {
      const value = this._eventLatLng(event, false);
      if (!value || !this._tooltip?.isOpen()) return;
      this._tooltip.setContentContext({ source: this, event, data: event.data });
      this._tooltip.setLatLng(value);
    };
    const close: EventHandler = () => {
      if (!this._tooltip?.options.permanent) this.closeTooltip();
    };
    const remove: EventHandler = () => this.closeTooltip();
    const add: EventHandler = () => {
      if (this._tooltip?.options.permanent) this.openTooltip();
    };
    this._tooltipHandlers = [
      ["mouseover", open],
      ["mousemove", move],
      ["mouseout", close],
      ["drag", move],
      ["add", add],
      ["remove", remove]
    ];
    for (const [type, handler] of this._tooltipHandlers) this.on(type, handler);
    if (this.map && this._tooltip.options.permanent) this.openTooltip();
    return this;
  }

  unbindTooltip(): this {
    for (const [type, handler] of this._tooltipHandlers) this.off(type, handler);
    this._tooltipHandlers = [];
    this._tooltip?.close();
    this._tooltip = null;
    return this;
  }

  openTooltip(value?: LatLngLike): this {
    if (!this.map || !this._tooltip) return this;
    this._tooltip.setLatLng(value ?? this._overlayAnchor()).openOn(this.map);
    return this;
  }

  closeTooltip(): this {
    this._tooltip?.close();
    return this;
  }

  isTooltipOpen(): boolean {
    return Boolean(this._tooltip?.isOpen());
  }

  getTooltip(): Tooltip | null {
    return this._tooltip;
  }

  protected _overlayAnchor(): LatLngLike {
    const located = this as unknown as Partial<LocatedLayer>;
    if (typeof located.getLatLng === "function") return located.getLatLng();
    const bounded = this as unknown as Partial<BoundedLayer>;
    if (typeof bounded.getBounds === "function") {
      const value = bounded.getBounds();
      if (!value.isValid || value.isValid()) return value.getCenter();
    }
    if (this.map) return this.map.getCenter();
    throw new Error("Layer has no geographic anchor");
  }

  private _eventLatLng(event: OrihonEvent, fallback = true): LatLngLike | undefined {
    const value = event.latlng;
    if (Array.isArray(value) || (typeof value === "object" && value !== null && "lat" in value && "lng" in value)) {
      return latLng(value as LatLngLike);
    }
    return fallback ? this._overlayAnchor() : undefined;
  }
}
