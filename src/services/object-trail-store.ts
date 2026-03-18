import type { ObjectId } from "./object-types.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import type { ObjectTrailStyle } from "./object-types.js";
import { rejectStyleAliases } from "../style-contract.js";

export interface TrailPoint {
  lat: number;
  lng: number;
  time: number;
}

export interface TrailPolyline {
  id: ObjectId;
  points: TrailPoint[];
  style: Required<Pick<ObjectTrailStyle, "stroke" | "strokeWidth" | "strokeOpacity">>;
}

const DEFAULT_TRAIL = {
  stroke: "#2563eb",
  strokeWidth: 2,
  strokeOpacity: 0.5,
  maxPoints: 40,
  maxAgeMs: 120_000
};

/** Hard cap on `style.trail.maxPoints` (availability). */
export const MAX_TRAIL_POINTS = 512;
/** Hard cap on `style.trail.maxAgeMs` (24h). */
export const MAX_TRAIL_AGE_MS = 86_400_000;

/**
 * Per-object trail history for Point motion.
 * Appends on logical coordinate change; batch-rendered via WebGLPathBatch.
 */
export class ObjectTrailStore {
  private readonly trails = new Map<ObjectId, TrailPoint[]>();
  private readonly styles = new Map<ObjectId, Required<typeof DEFAULT_TRAIL>>();

  clear(): void {
    this.trails.clear();
    this.styles.clear();
  }

  remove(id: ObjectId): void {
    this.trails.delete(id);
    this.styles.delete(id);
  }

  configure(id: ObjectId, style: ObjectTrailStyle | null | undefined): void {
    if (style) {
      rejectStyleAliases(style, "line");
      rejectLegacyUnit(style, "maxAge", "maxAgeMs");
      nonNegativeFinite(style.maxAgeMs ?? DEFAULT_TRAIL.maxAgeMs, "maxAgeMs");
    }
    if (!style || style.enabled === false) {
      this.remove(id);
      return;
    }
    this.styles.set(id, {
      stroke: style.stroke ?? DEFAULT_TRAIL.stroke,
      strokeWidth: style.strokeWidth ?? DEFAULT_TRAIL.strokeWidth,
      strokeOpacity: style.strokeOpacity ?? DEFAULT_TRAIL.strokeOpacity,
      maxPoints: Math.min(
        MAX_TRAIL_POINTS,
        Math.max(2, Math.floor(style.maxPoints ?? DEFAULT_TRAIL.maxPoints))
      ),
      maxAgeMs: Math.min(
        MAX_TRAIL_AGE_MS,
        Math.max(0, Number(style.maxAgeMs ?? DEFAULT_TRAIL.maxAgeMs))
      )
    });
    if (!this.trails.has(id)) this.trails.set(id, []);
  }

  append(id: ObjectId, lat: number, lng: number, now = Date.now()): void {
    const style = this.styles.get(id);
    if (!style) return;
    let points = this.trails.get(id);
    if (!points) {
      points = [];
      this.trails.set(id, points);
    }
    const last = points[points.length - 1];
    if (last && last.lat === lat && last.lng === lng) return;
    points.push({ lat, lng, time: now });
    this.#trim(id, now);
  }

  list(): TrailPolyline[] {
    const now = Date.now();
    const out: TrailPolyline[] = [];
    for (const [id, style] of this.styles) {
      this.#trim(id, now);
      const points = this.trails.get(id);
      if (!points || points.length < 2) continue;
      out.push({
        id,
        points: points.slice(),
        style: { stroke: style.stroke, strokeWidth: style.strokeWidth, strokeOpacity: style.strokeOpacity }
      });
    }
    return out;
  }

  #trim(id: ObjectId, now: number): void {
    const style = this.styles.get(id);
    const points = this.trails.get(id);
    if (!style || !points) return;
    const minTime = style.maxAgeMs > 0 ? now - style.maxAgeMs : Number.NEGATIVE_INFINITY;
    let start = 0;
    while (start < points.length && points[start].time < minTime) start++;
    if (start > 0) points.splice(0, start);
    if (points.length > style.maxPoints) {
      points.splice(0, points.length - style.maxPoints);
    }
  }
}
