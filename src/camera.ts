/**
 * Shared camera / projection helpers.
 *
 * Invariant for every geographic renderer (tiles, markers, SVG, canvas, WebGL):
 *
 *   screen = CRS.project(latLng, zoom) − pixelOrigin(zoom)
 *
 * During continuous (fractional) zoom, raster tiles may keep an integer
 * `paintedZoom` and CSS-scale into the live camera. That warp must use the
 * same math as reprojecting at `liveZoom`:
 *
 *   scale = 2 ** (liveZoom − paintedZoom)
 *   translate = paintedOrigin * scale − liveOrigin
 *   transform = translate3d(translate) scale(scale)   // origin 0 0
 *
 * Do not round camera geometry to integers before the final paint — sibling
 * panes must stay within sub-pixel agreement during wheel zoom.
 */

export interface CameraOrigin {
  x: number;
  y: number;
}

export interface CameraState {
  center: { lat: number; lng: number };
  zoom: number;
  pixelOrigin: CameraOrigin;
  size: { width: number; height: number };
}

/** CSS `translate3d` + optional `scale` without integer rounding. */
export function geoTransformCss(x: number, y: number, scale = 1): string {
  if (scale === 1) return `translate3d(${x}px,${y}px,0)`;
  return `translate3d(${x}px,${y}px,0) scale(${scale})`;
}

/**
 * Warp a surface painted at `(paintedZoom, paintedOrigin)` onto the live camera.
 * Transform origin must be `0 0`.
 */
export function cameraWarpCss(
  paintedOrigin: CameraOrigin,
  paintedZoom: number,
  liveOrigin: CameraOrigin,
  liveZoom: number
): string {
  const scale = 2 ** (liveZoom - paintedZoom);
  return geoTransformCss(
    paintedOrigin.x * scale - liveOrigin.x,
    paintedOrigin.y * scale - liveOrigin.y,
    scale
  );
}

/** Top-left of tile `(x,y)` at `tileZoom`, expressed in live layer pixels + CSS scale. */
export function tileCornerLayerTransform(
  tileX: number,
  tileY: number,
  tileSize: number,
  tileZoom: number,
  liveOrigin: CameraOrigin,
  liveZoom: number
): { x: number; y: number; scale: number; css: string } {
  const scale = 2 ** (liveZoom - tileZoom);
  const x = tileX * tileSize * scale - liveOrigin.x;
  const y = tileY * tileSize * scale - liveOrigin.y;
  return { x, y, scale, css: geoTransformCss(x, y, scale) };
}

/** Level container warp: tiles live in `levelOrigin` space at `levelZoom`. */
export function tileLevelWarpCss(
  levelOrigin: CameraOrigin,
  levelZoom: number,
  liveOrigin: CameraOrigin,
  liveZoom: number
): string {
  return cameraWarpCss(levelOrigin, levelZoom, liveOrigin, liveZoom);
}
