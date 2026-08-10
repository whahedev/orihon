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
