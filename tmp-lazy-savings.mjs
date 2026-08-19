import { build } from "esbuild";
import { gzipSync } from "zlib";
import { resolve } from "path";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

/**
 * Approximate incremental gzip savings by externalizing modules from advanced entry.
 * Not perfect (shared deps remain), but ranks lazy-split candidates.
 */
const candidates = {
  "object-manager+scene graph": [
    "./services/object-manager.js",
    "./services/object-scene.js",
    "./services/object-geometry.js",
    "./services/object-icon-atlas.js",
    "./services/object-search-index.js",
    "./services/object-time-index.js",
    "./services/object-trail-store.js",
    "./services/object-label-layout.js",
    "./services/object-cluster-aggregates.js",
    "./services/object-types.js",
    "./layers/webgl-symbol-layer.js",
    "./layers/webgl-styled-path-batch.js",
    "./layers/webgl-polygon-batch.js",
    "./layers/cluster-canvas-layer.js"
  ],
  "webgl-heat (+ isolines stack)": [
    "./layers/webgl-heat-layer.js",
    "./layers/heat-layer.js",
    "./layers/heat-isoline-layer.js",
    "./services/heat-isolines.js"
  ],
  "webgl-tile-layer": ["./layers/webgl-tile-layer.js"],
  "webgl-point-layer": ["./layers/webgl-point-layer.js"],
  "webgl-path-batch": ["./layers/webgl-path-batch.js"],
  "mvt+vector-tiles": ["./layers/mvt.js", "./layers/vector-tile-layer.js"],
  "cluster-layout+geometry-worker": [
    "./services/cluster-layout.js",
    "./services/geometry-worker.js"
  ],
  "locales-all-but-en": [], // handled separately
  "suggest+routing+traffic+search": [
    "./services/suggest.js",
    "./services/routing.js",
    "./services/traffic-layer.js",
    "./services/search.js"
  ],
  "offline+performance+framework-adapters": [
    "./services/offline-cache.js",
    "./services/performance.js",
    "./services/framework-adapters.js"
  ],
  "marker-collection": ["./layers/marker-collection.js"],
  "remote-object-manager": ["./services/remote-object-manager.js"],
  "map-export": ["./services/map-export.js"],
  "scene subsystems only (keep OM)": [
    "./layers/webgl-symbol-layer.js",
    "./layers/webgl-styled-path-batch.js",
    "./layers/webgl-polygon-batch.js",
    "./layers/webgl-heat-layer.js",
    "./services/object-icon-atlas.js",
    "./services/object-search-index.js",
    "./services/object-time-index.js",
    "./services/object-trail-store.js",
    "./services/object-label-layout.js",
    "./services/object-cluster-aggregates.js"
  ]
};

async function measure(external = []) {
  const result = await build({
    entryPoints: [resolve("dist/index.js")],
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    target: ["es2022"],
    legalComments: "none",
    external
  });
  const code = result.outputFiles[0].text;
  return gzipSync(code, { level: 9 }).length;
}

const baseline = await measure([]);
console.log("baseline gz", baseline);

for (const [label, externals] of Object.entries(candidates)) {
  if (!externals.length) continue;
  const gz = await measure(externals);
  console.log(String(baseline - gz).padStart(6), "KiB~", ((baseline - gz) / 1024).toFixed(2), " ", label);
}

// Locale: simulate en-only by replacing locale module
const localeSrc = readFileSync("dist/ui/locale.js", "utf8");
const enOnly = `
export const enLocale = Object.freeze({
  language: "en", rtl: false,
  mapLabel: "Interactive map", zoomIn: "Zoom in", zoomOut: "Zoom out",
  locate: "Show my location", locating: "Locating", locationError: "Location is unavailable",
  layers: "Layers", baseMaps: "Base maps", overlays: "Overlays", closePopup: "Close popup",
  meters: "m", kilometers: "km", feet: "ft", miles: "mi"
});
export const ruLocale = enLocale;
export const arLocale = enLocale;
export const trLocale = enLocale;
export const zhLocale = enLocale;
export const deLocale = enLocale;
export const frLocale = enLocale;
export const daLocale = enLocale;
export const hiLocale = enLocale;
export const locales = Object.freeze({ en: enLocale, ru: enLocale, ar: enLocale, tr: enLocale, zh: enLocale, de: enLocale, fr: enLocale, da: enLocale, hi: enLocale });
export function resolveLocale(input = "en") {
  if (typeof input === "string") return { ...(locales[input] ?? enLocale) };
  return { ...enLocale, ...input };
}
`;
writeFileSync("dist/ui/locale.en-stub.js", enOnly);
// can't easily swap without plugin — measure file delta
console.log(
  "locale full gz",
  gzipSync(localeSrc, { level: 9 }).length,
  "en-only gz",
  gzipSync(enOnly, { level: 9 }).length,
  "delta",
  gzipSync(localeSrc, { level: 9 }).length - gzipSync(enOnly, { level: 9 }).length
);
unlinkSync("dist/ui/locale.en-stub.js");

// Shader dedupe potential: count repeated merc transform + clip boilerplate in bundle
const bundle = readFileSync("dist/orihon.esm.js", "utf8");
const patterns = [
  "a_merc * u_scale - u_origin",
  "((pixel * u_dpr) / u_resolution) * 2.0 - 1.0",
  "precision mediump float",
  "Orihon pane not found"
];
for (const p of patterns) {
  console.log("pattern", JSON.stringify(p), "count", bundle.split(p).length - 1);
}
