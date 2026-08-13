export interface ScreenPoint { x: number; y: number }

/** Prefer the point 40% along a path, with an in-view vertex/centroid fallback. */
export function pickLabelAnchor(
  points: ScreenPoint[],
  pathLength: number,
  width: number,
  height: number,
  margin = 16
): ScreenPoint | null {
  if (!points.length) return null;
  const inView = (point: ScreenPoint): boolean => point.x >= margin && point.y >= margin
    && point.x <= width - margin && point.y <= height - margin;
  if (pathLength > 1 && points.length > 1) {
    const target = pathLength * 0.4;
    let walked = 0;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (walked + length >= target) {
        const ratio = length ? (target - walked) / length : 0;
        const anchor = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
        if (inView(anchor)) return anchor;
        break;
      }
      walked += length;
    }
  }
  const visible = points.find(inView);
  if (visible) return visible;
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return {
    x: Math.max(margin, Math.min(width - margin, center.x / points.length)),
    y: Math.max(margin, Math.min(height - margin, center.y / points.length))
  };
}
