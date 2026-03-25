export interface LabelCandidate {
  id: string | number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  collisionMode: "auto" | "always" | "hide";
  kind: "label" | "icon";
}

export interface LabelLayoutResult {
  visible: LabelCandidate[];
  hidden: LabelCandidate[];
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function toBox(candidate: LabelCandidate, padding: number): Box {
  return {
    left: candidate.x - padding,
    top: candidate.y - padding,
    right: candidate.x + candidate.width + padding,
    bottom: candidate.y + candidate.height + padding
  };
}

/**
 * Viewport declutter shared by ObjectManager labels/icons.
 * Higher priority wins; ties use stable id order.
 */
export function layoutObjectLabels(
  candidates: LabelCandidate[],
  options: { padding?: number; maxLabels?: number } = {}
): LabelLayoutResult {
  const padding = Math.max(0, Number(options.padding) || 4);
  const maxLabels = Math.max(1, Math.floor(Number(options.maxLabels) || 500));
  const sorted = candidates
    .slice()
    .sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)));

  const boxes: Box[] = [];
  const visible: LabelCandidate[] = [];
  const hidden: LabelCandidate[] = [];

  for (const candidate of sorted) {
    if (candidate.collisionMode === "hide") {
      hidden.push(candidate);
      continue;
    }
    if (candidate.collisionMode === "always") {
      if (visible.length < maxLabels) {
        visible.push(candidate);
        boxes.push(toBox(candidate, padding));
      } else {
        hidden.push(candidate);
      }
      continue;
    }
    if (visible.length >= maxLabels) {
      hidden.push(candidate);
      continue;
    }
    const box = toBox(candidate, padding);
    if (boxes.some((other) => overlaps(box, other))) {
      hidden.push(candidate);
      continue;
    }
    visible.push(candidate);
    boxes.push(box);
  }

  return { visible, hidden };
}

const textMetricsCache = new Map<string, { width: number; height: number }>();

export function measureLabelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: string
): { width: number; height: number } {
  const key = `${font}::${text}`;
  const cached = textMetricsCache.get(key);
  if (cached) return cached;
  ctx.font = font;
  const width = ctx.measureText(text).width;
  const height = Number(font.match(/([\d.]+)px/)?.[1] ?? 12);
  const metrics = { width, height };
  if (textMetricsCache.size > 5000) textMetricsCache.clear();
  textMetricsCache.set(key, metrics);
  return metrics;
}
