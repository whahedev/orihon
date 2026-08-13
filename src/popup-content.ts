import type { OverlayContentContext, OverlayMountable } from "./overlays/div-overlay.js";

export type PopupContentBlockType = "popupText" | "popupHtml" | "popupImage" | "popupVideo" | "popupChart" | string;

export interface PopupContentBlock {
  type: PopupContentBlockType;
  title?: string;
  visible?: boolean;
  props?: Record<string, unknown>;
}

export interface PopupContentSpec {
  title?: string;
  props?: Record<string, unknown>;
  children?: PopupContentBlock[];
}

export type PopupContentCleanup = void | (() => void) | { destroy(): void };
export type PopupChartRenderer = (
  container: HTMLElement,
  block: PopupContentBlock,
  context: OverlayContentContext
) => PopupContentCleanup | Promise<PopupContentCleanup>;

export interface PopupContentOptions {
  chartRenderer?: PopupChartRenderer;
  classPrefix?: string;
  emptyText?: string;
  properties?: (context: OverlayContentContext) => Record<string, unknown>;
}

export interface EChartsPopupRendererOptions {
  libraryUrl?: string;
  renderer?: "canvas" | "svg";
}

interface EChartsInstance {
  setOption(option: unknown): void;
  resize(): void;
  dispose(): void;
  isDisposed?(): boolean;
}

interface EChartsApi {
  init(container: HTMLElement, theme?: unknown, options?: { renderer?: "canvas" | "svg" }): EChartsInstance;
}

const chartLibraries = new Map<string, Promise<EChartsApi>>();

/**
 * Creates safe, lifecycle-aware declarative popup content. It can be passed
 * directly to `bindPopup()` and keeps product/editor schemas out of Popup.
 */
export function popupContent(spec: PopupContentSpec, options: PopupContentOptions = {}): OverlayMountable {
  return {
    async mount(container, context) {
      const popupProps = spec.props ?? {};
      const columns = clampInteger(popupProps.columns, 1, 3, 1);
      const gap = Math.max(0, finiteNumber(popupProps.gap, 12));
      const prefix = options.classPrefix?.trim() || "oh-rich-popup";
      const theme = stringValue(popupProps.theme, "light");
      const root = document.createElement("article");
      root.className = `${prefix}-stack is-${safeClassToken(theme)}`;
      root.style.cssText = `display:grid;width:100%;max-width:100%;min-width:0;box-sizing:border-box;max-height:min(340px,55vh);overflow:auto;gap:${gap}px;grid-template-columns:repeat(${columns},minmax(0,1fr));padding:14px`;
      if (theme === "dark") {
        root.style.background = "#17232a";
        root.style.color = "#f1f5f7";
      } else if (theme === "transparent") root.style.background = "transparent";
      container.append(root);

      if (spec.title) {
        const heading = document.createElement("strong");
        heading.className = `${prefix}-heading`;
        heading.style.cssText = "grid-column:1/-1;padding-right:22px;font-size:15px";
        heading.textContent = spec.title;
        root.append(heading);
      }

      const cleanups: Array<() => void> = [];
      for (const block of spec.children ?? []) {
        const props = block.props ?? {};
        if (block.visible === false || !popupConditionMatches(props.condition, context, options.properties)) continue;
        const cell = document.createElement("section");
        cell.className = `${prefix}-cell`;
        cell.style.cssText = `grid-column:span ${clampInteger(props.span, 1, columns, 1)};min-width:0;max-width:100%;overflow:hidden`;
        root.append(cell);

        if (block.type === "popupText") renderText(cell, props, prefix);
        else if (block.type === "popupHtml") renderHtml(cell, props, prefix);
        else if (block.type === "popupImage") renderImage(cell, props, prefix);
        else if (block.type === "popupVideo") cleanups.push(renderVideo(cell, props, prefix));
        else if (block.type === "popupChart" && options.chartRenderer) {
          const host = renderChartHost(cell, block, prefix);
          try {
            const cleanup = await options.chartRenderer(host, block, context);
            const dispose = cleanupFunction(cleanup);
            if (dispose) cleanups.push(dispose);
          } catch (error) {
            host.classList.add("is-error");
            host.textContent = error instanceof Error ? error.message : String(error);
          }
        }
      }

      if (!root.childElementCount) {
        const empty = document.createElement("p");
        empty.className = `${prefix}-empty`;
        empty.style.margin = "0";
        empty.textContent = options.emptyText ?? "Add content blocks to this popup.";
        root.append(empty);
      }
      return () => {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      };
    }
  };
}

/** A CSP-conscious sanitizer for the explicit HTML popup block. */
export function sanitizePopupHtml(value: unknown): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = String(value ?? "");
  template.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const content = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src" || name === "xlink:href") && content.startsWith("javascript:"))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return template.content.cloneNode(true) as DocumentFragment;
}

export function popupConditionMatches(
  expression: unknown,
  context: OverlayContentContext,
  resolveProperties: PopupContentOptions["properties"] = defaultProperties
): boolean {
  const source = String(expression ?? "").trim();
  if (!source) return true;
  const match = source.match(/^(!)?([\w.-]+)\s*(?:(=|!=)\s*(.+))?$/);
  if (!match) return false;
  const properties = resolveProperties?.(context) ?? {};
  const value = match[2].split(".").reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, properties);
  if (!match[3]) return match[1] ? !value : Boolean(value);
  return match[3] === "!=" ? String(value) !== match[4] : String(value) === match[4];
}

/** Optional ECharts adapter; ECharts is loaded only when the first chart mounts. */
export function createEChartsPopupRenderer(options: EChartsPopupRendererOptions = {}): PopupChartRenderer {
  return async (container, block) => {
    const props = block.props ?? {};
    const url = stringValue(props.libraryUrl, options.libraryUrl ?? "");
    const echarts = await loadECharts(url);
    if (!container.isConnected) return;
    const chart = echarts.init(container, undefined, { renderer: options.renderer ?? "canvas" });
    chart.setOption(echartsOption(props, block.title));
    const resize = (): void => {
      if (container.isConnected && !chart.isDisposed?.()) chart.resize();
    };
    const frame = requestAnimationFrame(resize);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (!chart.isDisposed?.()) chart.dispose();
    };
  };
}

function renderText(cell: HTMLElement, props: Record<string, unknown>, prefix: string): void {
  const tone = stringValue(props.tone, "body");
  const element = document.createElement(tone === "caption" ? "small" : "p");
  element.className = `${prefix}-text is-${safeClassToken(tone)}`;
  element.style.cssText = `margin:0;line-height:1.5${tone === "lead" ? ";font-size:15px;font-weight:560" : ""}`;
  element.textContent = stringValue(props.text);
  cell.append(element);
}

function renderHtml(cell: HTMLElement, props: Record<string, unknown>, prefix: string): void {
  const section = document.createElement("section");
  section.className = `${prefix}-html`;
  section.style.lineHeight = "1.5";
  section.append(sanitizePopupHtml(props.html));
  cell.append(section);
}

function renderImage(cell: HTMLElement, props: Record<string, unknown>, prefix: string): void {
  const figure = document.createElement("figure");
  figure.className = `${prefix}-media`;
  figure.style.cssText = "margin:0;overflow:hidden;border-radius:8px";
  const image = document.createElement("img");
  image.src = stringValue(props.url);
  image.alt = stringValue(props.alt);
  image.style.cssText = `display:block;width:100%;max-width:100%;object-fit:${stringValue(props.fit, "cover")}`;
  figure.append(image);
  if (props.caption) {
    const caption = document.createElement("figcaption");
    caption.textContent = String(props.caption);
    figure.append(caption);
  }
  cell.append(figure);
}

function renderVideo(cell: HTMLElement, props: Record<string, unknown>, prefix: string): () => void {
  const video = document.createElement("video");
  const autoplay = props.autoplay !== false;
  const muted = props.muted !== false;
  video.className = `${prefix}-video`;
  video.src = stringValue(props.url);
  video.poster = stringValue(props.poster);
  video.controls = props.controls !== false;
  video.autoplay = autoplay;
  video.muted = muted;
  video.defaultMuted = muted;
  video.playsInline = true;
  video.preload = autoplay ? "auto" : "metadata";
  video.style.cssText = `display:block;width:100%;max-width:100%;aspect-ratio:${stringValue(props.aspectRatio, "16/9")};object-fit:${stringValue(props.fit, "cover")}`;
  if (autoplay) video.setAttribute("autoplay", "");
  if (muted) video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  cell.append(video);
  if (autoplay) void video.play().catch(() => {});
  return () => video.pause();
}

function renderChartHost(cell: HTMLElement, block: PopupContentBlock, prefix: string): HTMLElement {
  const props = block.props ?? {};
  const section = document.createElement("section");
  section.className = `${prefix}-chart-block`;
  section.style.cssText = "display:grid;min-width:0;max-width:100%;gap:6px";
  if (props.title || block.title) {
    const title = document.createElement("strong");
    title.textContent = stringValue(props.title, block.title ?? "");
    section.append(title);
  }
  const host = document.createElement("div");
  host.className = `${prefix}-chart`;
  host.style.cssText = `width:100%;max-width:100%;min-width:0;height:${Math.max(80, finiteNumber(props.height, 190))}px;overflow:hidden`;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", stringValue(props.title, block.title ?? "Chart"));
  section.append(host);
  cell.append(section);
  return host;
}

function defaultProperties(context: OverlayContentContext): Record<string, unknown> {
  const event = context.event as unknown as { feature?: { properties?: Record<string, unknown> } } | undefined;
  const direct = context as unknown as { feature?: { properties?: Record<string, unknown> }; properties?: Record<string, unknown> };
  return event?.feature?.properties ?? direct.feature?.properties ?? direct.properties ?? {};
}

function loadECharts(url: string): Promise<EChartsApi> {
  const existing = (globalThis as typeof globalThis & { echarts?: EChartsApi }).echarts;
  if (existing) return Promise.resolve(existing);
  if (!url) return Promise.reject(new Error("ECharts library URL is empty"));
  let pending = chartLibraries.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.dataset.orihonChartLibrary = url;
      script.onload = () => {
        const loaded = (globalThis as typeof globalThis & { echarts?: EChartsApi }).echarts;
        if (loaded) resolve(loaded);
        else reject(new Error("ECharts did not initialise"));
      };
      script.onerror = () => reject(new Error("Could not load ECharts"));
      document.head.append(script);
    });
    chartLibraries.set(url, pending);
  }
  return pending;
}

function echartsOption(props: Record<string, unknown>, fallbackTitle?: string): unknown {
  const labels = csv(props.labels);
  const values = csv(props.values).map(Number).map((value) => Number.isFinite(value) ? value : 0);
  const chartType = stringValue(props.chartType, "bar");
  const color = stringValue(props.color, "#0f766e");
  if (chartType === "gauge") {
    return { series: [{ type: "gauge", progress: { show: true }, data: [{ value: values[0] ?? 0, name: labels[0] ?? stringValue(props.title, fallbackTitle ?? "Value") }] }] };
  }
  if (chartType === "pie" || chartType === "donut") {
    return { color: [color, "#14b8a6", "#2dd4bf", "#5eead4", "#99f6e4"], tooltip: { trigger: "item" }, series: [{ type: "pie", radius: chartType === "donut" ? ["38%", "70%"] : "70%", data: values.map((value, index) => ({ value, name: labels[index] ?? `Item ${index + 1}` })) }] };
  }
  return { color: [color], grid: { top: 18, right: 12, bottom: 28, left: 38 }, tooltip: { trigger: "axis" }, xAxis: { type: "category", data: labels, axisTick: { show: false } }, yAxis: { type: "value", splitLine: { lineStyle: { color: "#e2e8f0" } } }, series: [{ type: chartType === "area" ? "line" : ["line", "scatter"].includes(chartType) ? chartType : "bar", data: values, smooth: true, areaStyle: chartType === "area" ? {} : undefined, itemStyle: { borderRadius: [4, 4, 0, 0] } }] };
}

function cleanupFunction(value: PopupContentCleanup): (() => void) | null {
  if (typeof value === "function") return value;
  if (value && typeof value.destroy === "function") return () => value.destroy();
  return null;
}

function stringValue(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Math.round(finiteNumber(value, fallback))));
}

function csv(value: unknown): string[] {
  return stringValue(value).split(",").map((part) => part.trim()).filter(Boolean);
}

function safeClassToken(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "-") || "default";
}
