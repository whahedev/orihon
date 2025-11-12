export function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  parent?.appendChild(el);
  return el;
}

export function setTransform(el: HTMLElement | SVGElement, x: number, y: number, scale = 1): void {
  el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0) scale(${scale})`;
}

export function empty(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export function listen<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export interface TapListenerOptions {
  tolerance?: number;
  button?: number;
}

/**
 * Listens for an activation without relying solely on the browser's synthetic
 * `click`. Pointer gestures that move beyond the tolerance are ignored, while
 * keyboard/programmatic clicks remain supported. The handler runs once even
 * when a normal pointer tap produces both `pointerup` and `click`.
 */
export function listenTap(
  target: EventTarget,
  handler: (event: MouseEvent | PointerEvent) => void,
  options: TapListenerOptions = {}
): () => void {
  const tolerance = Math.max(0, Number(options.tolerance ?? 7));
  const button = Number(options.button ?? 0);
  let start: { x: number; y: number; pointerId: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPending = (): void => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
  };
  const clearSuppression = (): void => {
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    suppressTimer = null;
    suppressClick = false;
  };
  const down = (event: Event): void => {
    const pointer = event as PointerEvent;
    clearPending();
    clearSuppression();
    start = pointer.button === button
      ? { x: pointer.clientX, y: pointer.clientY, pointerId: pointer.pointerId }
      : null;
  };
  const up = (event: Event): void => {
    const pointer = event as PointerEvent;
    const origin = start;
    start = null;
    if (!origin || (Number.isFinite(origin.pointerId) && origin.pointerId !== pointer.pointerId)) return;
    const moved = Math.hypot(pointer.clientX - origin.x, pointer.clientY - origin.y) > tolerance;
    if (moved) {
      suppressClick = true;
      suppressTimer = setTimeout(clearSuppression, 0);
      return;
    }
    pending = setTimeout(() => {
      pending = null;
      handler(pointer);
    }, 0);
  };
  const cancel = (): void => {
    start = null;
    clearPending();
  };
  const click = (event: Event): void => {
    if (suppressClick) {
      clearSuppression();
      return;
    }
    clearPending();
    handler(event as MouseEvent);
  };

  const unsubs = [
    listen(target, "pointerdown", down),
    listen(target, "pointerup", up),
    listen(target, "pointercancel", cancel),
    listen(target, "click", click)
  ];
  return () => {
    clearPending();
    clearSuppression();
    for (const unsubscribe of unsubs) unsubscribe();
  };
}

export function rafThrottle<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void {
  let frame = 0;
  let lastArgs: TArgs;
  return (...args: TArgs) => {
    lastArgs = args;
    if (typeof requestAnimationFrame !== "function") {
      fn(...lastArgs);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn(...lastArgs);
    });
  };
}

export function getContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === "string") {
    const found = document.getElementById(container);
    if (!found) throw new Error(`Orihon container not found: ${container}`);
    return found;
  }
  if (!container) throw new Error("Orihon container is required");
  return container;
}
