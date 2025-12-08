export interface HeatKernelScale {
  /** `2^(zoom - scaleZoom)` — geographic kernel in both zoom directions. */
  geographicScale: number;
  /** Screen scale after min/max CSS clamp, relative to `baseRadiusCss`. */
  radiusScale: number;
  /** Kernel size in CSS px after clamp. */
  radiusCss: number;
  /**
   * Multiply splat weight so color tracks geographic density
   * (mass / kernel area), not screen-space overlap count.
   */
  intensityScale: number;
}

/**
 * Screen kernel scale vs the zoom where `radius` is defined.
 * Follows mercator: zoom in → larger px kernel (same km), zoom out → smaller.
 * Layers clamp to min/max CSS px separately; `heatIntensityScale` then
 * restores density so those clamps cannot inflate far-zoom values.
 */
export function heatRadiusScale(zoom: number, scaleZoom: number): number {
  return 2 ** (zoom - scaleZoom);
}

/**
 * Intensity vs zoom so a uniform field stays the same color at every zoom.
 *
 * A splat's peak is independent of `gl_PointSize` (falloff is in point-coord).
 * Overlap for uniform density grows with world-area of the kernel:
 * `n ∝ radiusCss² / 2^(2z)`. For constant density:
 * `intensity ∝ 2^(2z) / radiusCss²` = `4^(zoom - scaleZoom) / radiusScale²`.
 *
 * Unclamped geographic radius ⇒ scale 1. Min-pixel stamps on zoom-out are
 * dimmed. Max-pixel caps on zoom-in are boosted so the field does not go
 * cold (and therefore does not jump to red when you zoom back out).
 */
export function heatIntensityScale(
  zoom: number,
  scaleZoom: number,
  radiusScale = heatRadiusScale(zoom, scaleZoom)
): number {
  const dz = zoom - scaleZoom;
  const r = Math.max(radiusScale, 1e-8);
  return 4 ** dz / (r * r);
}

/** Kernel CSS size + density scale after min/max pixel clamps. */
export function heatKernelAtZoom(
  zoom: number,
  scaleZoom: number,
  baseRadiusCss: number,
  options?: { minRadiusCss?: number; maxRadiusCss?: number }
): HeatKernelScale {
  const geographicScale = heatRadiusScale(zoom, scaleZoom);
  const base = Math.max(baseRadiusCss, 1e-6);
  const unclamped = base * geographicScale;
  const minR = options?.minRadiusCss ?? 0;
  const maxR = options?.maxRadiusCss ?? Infinity;
  const radiusCss = Math.min(maxR, Math.max(minR, unclamped));
  const radiusScale = radiusCss / base;
  return {
    geographicScale,
    radiusScale,
    radiusCss,
    intensityScale: heatIntensityScale(zoom, scaleZoom, radiusScale)
  };
}

/**
 * The last heat paint cannot cover this camera.
 * Zoom-out reveals new world (CSS scale-down leaves empty map).
 * Zoom-in stretches soft alpha into glowing aureoles — rebuild soon.
 * Pan past overscan does the same.
 *
 * `zoomLevels` widens the CSS-warp band to ±N map zooms (value fields use 1
 * so paused temperatures do not reshuffle reds on every zoom tick).
 */
export function heatWarpNeedsGpu(
  scale: number,
  tx: number,
  ty: number,
  coverPx: number,
  options?: { zoomLevels?: number }
): boolean {
  const levels = Math.max(0, options?.zoomLevels ?? 0);
  const lo = levels > 0 ? 2 ** -levels : 0.9;
  const hi = levels > 0 ? 2 ** levels : 1.12;
  if (scale < lo || scale > hi) return true;
  if (Math.abs(scale - 1) >= 0.04) return false;
  return Math.abs(tx) > coverPx || Math.abs(ty) > coverPx;
}

/**
 * Value-heatmap tone from local stats.
 * Pure mean stays green even at ~20% alarms; pure peak paints a hub red from ~2%.
 * Blend toward peak by the kernel mass share of alarms (smooth ~4%→18%).
 * Cap blend below 1 so zoom-driven neighbourhood changes cannot flip a cell to full peak.
 */
export function valueHeatTone(
  mean: number,
  peak: number,
  hotFrac: number,
  options?: { coolShare?: number; hotShare?: number; peakBlend?: number }
): number {
  const coolShare = options?.coolShare ?? 0.04;
  const hotShare = options?.hotShare ?? 0.18;
  const peakBlend = options?.peakBlend ?? 0.62;
  const span = Math.max(hotShare - coolShare, 1e-6);
  const x = Math.min(1, Math.max(0, (hotFrac - coolShare) / span));
  const blend = x * x * (3 - 2 * x) * peakBlend;
  const m = Number.isFinite(mean) ? mean : 0;
  const p = Number.isFinite(peak) ? peak : m;
  return Math.min(1, Math.max(0, m * (1 - blend) + p * blend));
}
