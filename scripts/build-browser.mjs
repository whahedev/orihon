import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { minify } from "terser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifestPath = resolve(dist, "release-manifest.json");

await mkdir(dist, { recursive: true });
await copyFile(resolve(root, "src", "orihon.css"), resolve(dist, "orihon.css"));
await copyFile(resolve(root, "src", "draw", "orihon.draw.css"), resolve(dist, "draw.css"));

const banner = `/*! Orihon ${pkg.version} | PolyForm-Noncommercial-1.0.0 | Copyright (c) 2026 whahe */`;
const artifacts = [
  { entry: "core.ts", file: "orihon.core.esm.js", format: "esm", external: ["./services/map-export.js"] },
  { entry: "standard.ts", file: "orihon.standard.esm.js", format: "esm", external: ["./services/map-export.js"] },
  { entry: "index.ts", file: "orihon.esm.js", format: "esm" },
  { entry: "controls.ts", file: "orihon.controls.esm.js", format: "esm", bundle: false },
  { entry: "geo-entry.ts", file: "orihon.geo.esm.js", format: "esm", bundle: false },
  { entry: "popup-content.ts", file: "orihon.popup-content.esm.js", format: "esm", bundle: false },
  { entry: "draw/index.ts", file: "orihon.draw.esm.js", format: "esm", peerExternal: true },
  { entry: "react/index.ts", file: "orihon.react.esm.js", format: "esm", external: ["react", "react-dom/client"] },
  { entry: "index.ts", file: "orihon.global.js", format: "iife", globalName: "Orihon" }
];

for (const artifact of artifacts) {
  await build({
    entryPoints: [resolve(root, "src", artifact.entry)],
    outfile: resolve(dist, artifact.file),
    bundle: artifact.bundle ?? true,
    format: artifact.format,
    globalName: artifact.globalName,
    minify: true,
    sourcemap: true,
    target: ["es2022"],
    legalComments: "none",
    banner: { js: banner },
    footer: artifact.format === "iife"
      ? { js: "globalThis.OrihonReady=Promise.resolve(Orihon);" }
      : undefined,
    external: artifact.external,
    plugins: artifact.peerExternal ? [{
      name: "externalize-orihon-peer",
      setup(build) {
        build.onResolve({ filter: /^\.\.\// }, () => ({ path: "orihon/standard", external: true }));
      }
    }] : undefined
  });
  if (artifact.file === "orihon.esm.js") {
    const output = resolve(dist, artifact.file);
    const sourceMapPath = `${output}.map`;
    const compact = await minify(await readFile(output, "utf8"), {
      module: true,
      compress: { passes: 8, booleans_as_integers: true, keep_fargs: false },
      mangle: {
        // Do not mangle underscore properties: esbuild's class-field helper
        // (when used) keeps quoted names like "_unsub", while Terser would
        // rename bare `this._unsub` — breaking createMap in the CDN bundle.
        // Size win is small vs. a hard runtime crash.
        properties: false
      },
      format: { comments: /^!/ },
      sourceMap: {
        content: await readFile(sourceMapPath, "utf8"),
        filename: artifact.file,
        url: `${artifact.file}.map`
      }
    });
    if (!compact.code) throw new Error(`Terser produced no code for ${artifact.file}`);
    await writeFile(output, compact.code);
    if (compact.map) await writeFile(sourceMapPath, compact.map);
  }
}

const sizes = Object.fromEntries(await Promise.all(artifacts.map(async ({ file }) => {
  const contents = await readFile(resolve(dist, file));
  return [file, { bytes: contents.length, gzipBytes: gzipSync(contents, { level: 9 }).length }];
})));

await writeFile(manifestPath, JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  module: "index.js",
  core: "core.js",
  standard: "standard.js",
  controls: "controls.js",
  geo: "geo-entry.js",
  popupContent: "popup-content.js",
  bundledModule: "orihon.esm.js",
  global: "orihon.global.js",
  css: "orihon.css",
  sizes
}, null, 2));
