import { build } from "esbuild";
import { gzipSync } from "zlib";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { minify } from "terser";

const root = resolve(".");

async function bundleGz(entryRelative, extras = {}) {
  const result = await build({
    entryPoints: [resolve(root, entryRelative)],
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    target: ["es2022"],
    legalComments: "none",
    ...extras
  });
  const code = result.outputFiles[0].text;
  return {
    raw: Buffer.byteLength(code),
    gz: gzipSync(code, { level: 9 }).length,
    code
  };
}

const meta = await build({
  entryPoints: [resolve(root, "dist/index.js")],
  bundle: true,
  write: false,
  format: "esm",
  minify: true,
  metafile: true,
  target: ["es2022"],
  legalComments: "none"
});
const out = Object.values(meta.metafile.outputs)[0];
const contrib = Object.entries(out.inputs || {})
  .map(([p, i]) => ({
    p: p.replace(/\\/g, "/").replace(/^.*?dist\//, "dist/"),
    b: i.bytesInOutput
  }))
  .sort((a, b) => b.b - a.b);
console.log("TOP MODULES IN ADVANCED BUNDLE (bytesInOutput):");
console.log(contrib.slice(0, 50).map((x) => String(x.b).padStart(7) + " " + x.p).join("\n"));

const groups = {};
for (const x of contrib) {
  let g = "other";
  if (x.p.includes("/webgl-")) g = "webgl-layers";
  else if (x.p.includes("object-")) g = "object-*";
  else if (x.p.includes("/services/cluster")) g = "cluster";
  else if (x.p.includes("/services/")) g = "services-other";
  else if (x.p.includes("/layers/")) g = "layers-other";
  else if (x.p.includes("/ui/")) g = "ui";
  else if (x.p.includes("/overlays/")) g = "overlays";
  else if (x.p.includes("/draw/")) g = "draw";
  else g = "coreish";
  groups[g] = (groups[g] || 0) + x.b;
}
console.log("\nGROUPS:");
console.log(
  Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => String(v).padStart(7) + " " + k)
    .join("\n")
);

// Hypothetical: drop optional advanced services from an entry that mirrors index
const dropCandidates = [
  "suggest",
  "routing",
  "traffic-layer",
  "framework-adapters",
  "performance",
  "offline-cache",
  "heat-isolines",
  "heat-isoline-layer",
  "heat-layer",
  "marker-collection",
  "remote-object-manager",
  "mvt",
  "vector-tile-layer",
  "webgl-tile-layer",
  "webgl-heat-layer",
  "webgl-symbol-layer",
  "webgl-styled-path-batch",
  "webgl-polygon-batch",
  "webgl-path-batch",
  "webgl-point-layer",
  "object-manager",
  "cluster-layout",
  "geometry-worker",
  "locale"
];

console.log("\nMODULE FILE GZIP (standalone, not incremental):");
for (const name of [
  "dist/services/object-manager.js",
  "dist/services/object-scene.js",
  "dist/services/cluster-layout.js",
  "dist/services/geometry-worker.js",
  "dist/layers/webgl-point-layer.js",
  "dist/layers/webgl-heat-layer.js",
  "dist/layers/webgl-tile-layer.js",
  "dist/layers/webgl-symbol-layer.js",
  "dist/layers/webgl-path-batch.js",
  "dist/layers/webgl-styled-path-batch.js",
  "dist/layers/webgl-polygon-batch.js",
  "dist/ui/locale.js",
  "dist/services/suggest.js",
  "dist/services/routing.js",
  "dist/services/traffic-layer.js",
  "dist/services/framework-adapters.js",
  "dist/services/performance.js",
  "dist/services/offline-cache.js",
  "dist/services/heat-isolines.js",
  "dist/layers/heat-isoline-layer.js",
  "dist/layers/heat-layer.js",
  "dist/layers/mvt.js",
  "dist/layers/vector-tile-layer.js",
  "dist/layers/marker-collection.js",
  "dist/services/remote-object-manager.js",
  "dist/services/object-search-index.js",
  "dist/services/object-time-index.js",
  "dist/services/object-trail-store.js",
  "dist/services/object-label-layout.js",
  "dist/services/object-icon-atlas.js",
  "dist/services/object-cluster-aggregates.js",
  "dist/services/object-geometry.js",
  "dist/orihon.css"
]) {
  const buf = readFileSync(name);
  console.log(String(gzipSync(buf, { level: 9 }).length).padStart(6), name);
}

// Property mangling experiment on current orihon.esm.js
const src = readFileSync("dist/orihon.esm.js", "utf8");
const baselineGz = gzipSync(src, { level: 9 }).length;
const reserved = [
  // DOM / browser
  "length", "name", "type", "style", "className", "id", "href", "src",
  "width", "height", "left", "top", "right", "bottom", "opacity",
  "addEventListener", "removeEventListener", "dispatchEvent",
  "createElement", "appendChild", "removeChild", "getContext",
  "fillStyle", "strokeStyle", "lineWidth", "beginPath", "closePath",
  "moveTo", "lineTo", "stroke", "fill", "arc", "drawImage",
  "bufferData", "bufferSubData", "bindBuffer", "createBuffer",
  "createProgram", "createShader", "shaderSource", "compileShader",
  "attachShader", "linkProgram", "useProgram", "getAttribLocation",
  "getUniformLocation", "enableVertexAttribArray", "vertexAttribPointer",
  "uniform1f", "uniform2f", "uniform4f", "uniform1i", "uniformMatrix",
  "drawArrays", "drawElements", "viewport", "clearColor", "clear",
  "createTexture", "bindTexture", "texImage2D", "activeTexture",
  "ARRAY_BUFFER", "STATIC_DRAW", "DYNAMIC_DRAW", "FLOAT", "TRIANGLE_STRIP",
  "COLOR_BUFFER_BIT", "BLEND", "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA",
  // common public-ish map API field names often accessed dynamically
  "lat", "lng", "zoom", "center", "options", "map", "layer", "layers",
  "container", "pane", "attribution", "interactive", "opacity"
];

const mangled = await minify(src, {
  module: true,
  compress: false,
  mangle: {
    properties: {
      regex: /^_/,
      reserved
    }
  }
});
const mangledGz = gzipSync(mangled.code, { level: 9 }).length;
console.log("\nPROPERTY MANGLE (regex /^_/ only):");
console.log("baseline gz", baselineGz, "mangled gz", mangledGz, "delta", baselineGz - mangledGz);

const mangledAll = await minify(src, {
  module: true,
  compress: false,
  mangle: {
    properties: {
      // keep quoted / DOM-ish via reserved; still risky
      reserved: reserved.concat(["_unsub", "unsub"])
    }
  }
});
console.log(
  "broader properties mangle gz",
  gzipSync(mangledAll.code, { level: 9 }).length,
  "delta",
  baselineGz - gzipSync(mangledAll.code, { level: 9 }).length
);

// Locale packing simulation
const locale = readFileSync("dist/ui/locale.js", "utf8");
console.log("\nlocale.js gz", gzipSync(locale, { level: 9 }).length);

writeFileSync("tmp-contrib.json", JSON.stringify(contrib, null, 2));
