import { createElement, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PopupOptions, TooltipOptions } from "../overlays/div-overlay.js";
import { LayerContext } from "./context.js";

function contentNode(children: ReactNode): { content: Node | string | number | null; root: Root | null } {
  if (children == null || typeof children === "string" || typeof children === "number") {
    return { content: children ?? null, root: null };
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(createElement("div", null, children));
  return { content: container, root };
}

export interface PopupProps extends PopupOptions { children?: ReactNode; }

export function Popup({ children, ...options }: PopupProps) {
  const layer = useContext(LayerContext);
  const root = useRef<Root | null>(null);
  useLayoutEffect(() => {
    if (!layer) throw new Error("<Popup> must be a child of a layer component");
    const rendered = contentNode(children);
    root.current = rendered.root;
    layer.bindPopup(rendered.content, options);
    return () => {
      layer.unbindPopup();
      root.current?.unmount();
      root.current = null;
    };
  }, [layer, children]);
  return null;
}

export interface TooltipProps extends TooltipOptions { children?: ReactNode; }

export function Tooltip({ children, ...options }: TooltipProps) {
  const layer = useContext(LayerContext);
  useLayoutEffect(() => {
    if (!layer) throw new Error("<Tooltip> must be a child of a layer component");
    const rendered = contentNode(children);
    layer.bindTooltip(rendered.content, options);
    return () => {
      layer.unbindTooltip();
      rendered.root?.unmount();
    };
  }, [layer, children]);
  return null;
}
