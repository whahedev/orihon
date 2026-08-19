import { readFileSync } from "fs";
import { gzipSync } from "zlib";

const files = [
  "src/layers/webgl-point-layer.ts",
  "src/layers/webgl-symbol-layer.ts",
  "src/layers/webgl-path-batch.ts",
  "src/layers/webgl-heat-layer.ts",
  "src/layers/webgl-tile-layer.ts",
  "src/layers/webgl-styled-path-batch.ts",
  "src/layers/webgl-polygon-batch.ts"
];

function extractShaders(src) {
  const out = [];
  const re = /compileShader\([^,]+,\s*[^,]+,\s*`([\s\S]*?)`\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

let total = 0;
const rotateSnippet = "if (u_rotate != 0.0 || u_pitch != 1.0)";
const mercSnippet = "a_merc * u_scale - u_origin";
let rotateHits = 0;
let mercHits = 0;
for (const f of files) {
  const s = readFileSync(f, "utf8");
  const shaders = extractShaders(s);
  const chars = shaders.reduce((a, b) => a + b.length, 0);
  total += chars;
  if (s.includes(rotateSnippet) || shaders.some((x) => x.includes("u_rotate"))) rotateHits++;
  if (shaders.some((x) => x.includes(mercSnippet) || x.includes("* u_scale - u_origin"))) mercHits++;
  console.log(f.split("/").pop(), "shaders", shaders.length, "chars", chars);
}
console.log("total GLSL template chars", total);
console.log("approx gzip of concatenated GLSL", gzipSync(Buffer.from("x".repeat(0))).length);
const all = files.map((f) => extractShaders(readFileSync(f, "utf8")).join("\n")).join("\n");
console.log("concat GLSL gz", gzipSync(all, { level: 9 }).length);
console.log("merc transform pattern in layers", mercHits, "rotate/pitch pattern", rotateHits);

// canvas fallback method sizes
for (const f of ["src/layers/webgl-point-layer.ts", "src/layers/webgl-path-batch.ts", "src/layers/webgl-symbol-layer.ts", "src/layers/webgl-heat-layer.ts"]) {
  const s = readFileSync(f, "utf8");
  const idx = s.search(/#drawCanvas|#paintCanvas|renderer === \"canvas\"|fallbackCanvas/);
  console.log(f.split("/").pop(), "fallback mentions", (s.match(/fallbackCanvas|getContext\(\"2d\"\)|#drawCanvas|#renderCanvas/g) || []).length, "file gz", gzipSync(s).length);
}

const locale = readFileSync("src/ui/locale.ts", "utf8");
console.log("locale.ts", locale.length, "gz", gzipSync(locale, { level: 9 }).length);
const distLocale = readFileSync("dist/ui/locale.js");
console.log("dist locale.js", distLocale.length, "gz", gzipSync(distLocale, { level: 9 }).length);

const earStart = "export function earcutRing";
const poly = readFileSync("src/layers/webgl-polygon-batch.ts", "utf8");
const ear = poly.slice(poly.indexOf(earStart));
console.log("earcut+helpers chars", ear.length, "gz", gzipSync(ear, { level: 9 }).length);

// error message duplication
const err = "Orihon pane not found";
let errCount = 0;
import { readdirSync } from "fs";
import { join } from "path";
function walk(d, acc = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}
for (const p of walk("src")) {
  const s = readFileSync(p, "utf8");
  const n = s.split(err).length - 1;
  errCount += n;
}
console.log("Orihon pane not found occurrences", errCount);

// private property names sample in advanced bundle
const bundle = readFileSync("dist/orihon.esm.js", "utf8");
const props = new Set(bundle.match(/\._[a-zA-Z][a-zA-Z0-9]*/g) || []);
const long = [...props].filter((p) => p.length > 6).sort((a, b) => b.length - a.length);
console.log("underscore props count", props.size, "long sample", long.slice(0, 25).join(", "));
const underscored = [...props].join("");
console.log("sum underscore prop name chars", underscored.length);

// estimate property mangle savings: replace long private names with 1-2 char
let est = 0;
for (const p of props) {
  if (p.length <= 3) continue;
  // rough occurrence count
  const occ = bundle.split(p).length - 1;
  est += occ * (p.length - 2); // save to 1-char after dot? ._x
}
console.log("rough property mangle raw char savings", est, "gz~", Math.round(est * 0.25));
