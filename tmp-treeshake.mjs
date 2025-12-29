import { build } from "esbuild";
import { gzipSync } from "zlib";
import { resolve } from "path";
import { writeFileSync, unlinkSync } from "fs";

// Simulate app that only needs createMap + tileLayer from package root
writeFileSync(
  "tmp-app-coreish.js",
  `import { createMap, tileLayer } from "./dist/index.js";\nconsole.log(createMap, tileLayer);\n`
);
writeFileSync(
  "tmp-app-standardish.js",
  `import { createMap, tileLayer, marker, geoJSON } from "./dist/index.js";\nconsole.log(createMap, tileLayer, marker, geoJSON);\n`
);
writeFileSync(
  "tmp-app-om.js",
  `import { createMap, objectManager } from "./dist/index.js";\nconsole.log(createMap, objectManager);\n`
);
writeFileSync(
  "tmp-app-from-core.js",
  `import { createMap, tileLayer } from "./dist/core.js";\nconsole.log(createMap, tileLayer);\n`
);
writeFileSync(
  "tmp-app-from-standard.js",
  `import { createMap, tileLayer, marker, geoJSON } from "./dist/standard.js";\nconsole.log(createMap, tileLayer, marker, geoJSON);\n`
);

async function app(file) {
  const result = await build({
    entryPoints: [resolve(file)],
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    target: ["es2022"],
    legalComments: "none",
    packages: "bundle"
  });
  const code = result.outputFiles[0].text;
  return { raw: code.length, gz: gzipSync(code, { level: 9 }).length };
}

for (const f of [
  "tmp-app-from-core.js",
  "tmp-app-from-standard.js",
  "tmp-app-coreish.js",
  "tmp-app-standardish.js",
  "tmp-app-om.js"
]) {
  const r = await app(f);
  console.log(f, "gz", r.gz, "raw", r.raw);
}

for (const f of [
  "tmp-app-coreish.js",
  "tmp-app-standardish.js",
  "tmp-app-om.js",
  "tmp-app-from-core.js",
  "tmp-app-from-standard.js"
]) {
  unlinkSync(f);
}

// Estimate canvas-fallback share inside webgl-point by comparing source sections
import { readFileSync } from "fs";
const point = readFileSync("src/layers/webgl-point-layer.ts", "utf8");
const canvasFns = [...point.matchAll(/#(drawCanvas|renderCanvas|projectVisibleCanvas|paintFallback)[\s\S]*?(?=\n  #|\n  [a-zA-Z]|\$)/g)];
console.log("\nwebgl-point canvas-ish method matches", canvasFns.length);
const canvasBlock = point.includes("#projectVisibleCanvas")
  ? point.slice(point.indexOf("#projectVisibleCanvas"), point.indexOf("function normalizePointSize"))
  : "";
console.log("canvas projection+draw region chars", canvasBlock.length, "gz", gzipSync(canvasBlock, { level: 9 }).length);

const symbol = readFileSync("src/layers/webgl-symbol-layer.ts", "utf8");
const symCanvas = symbol.includes("getContext(\"2d\")")
  ? symbol.slice(symbol.lastIndexOf("getContext(\"2d\")") - 200)
  : "";
console.log("symbol tail from last 2d context chars", Math.min(symCanvas.length, 2500));

// Upload helper duplication: count bufferSubData patterns
const layers = [
  "webgl-point-layer",
  "webgl-path-batch",
  "webgl-heat-layer",
  "webgl-symbol-layer",
  "webgl-tile-layer"
];
for (const name of layers) {
  const s = readFileSync(`src/layers/${name}.ts`, "utf8");
  console.log(
    name,
    "bufferSubData",
    (s.match(/bufferSubData/g) || []).length,
    "createProgram",
    (s.match(/createProgram/g) || []).length,
    "compileShader",
    (s.match(/compileShader/g) || []).length
  );
}
