import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifestPath = resolve(dist, "release-manifest.json");

await mkdir(dist, { recursive: true });
await copyFile(resolve(root, "src", "orihon.css"), resolve(dist, "orihon.css"));

const banner = `/*! Orihon ${pkg.version} | PolyForm-Noncommercial-1.0.0 | Copyright (c) 2026 whahe */`;
const artifacts = [
  { entry: "core.ts", file: "orihon.core.esm.js", format: "esm" },
  { entry: "standard.ts", file: "orihon.standard.esm.js", format: "esm" },
  { entry: "index.ts", file: "orihon.esm.js", format: "esm" },
  { entry: "index.ts", file: "orihon.global.js", format: "iife", globalName: "Orihon" }
];

for (const artifact of artifacts) {
  await build({
    entryPoints: [resolve(root, "src", artifact.entry)],
    outfile: resolve(dist, artifact.file),
    bundle: true,
    format: artifact.format,
    globalName: artifact.globalName,
    minify: true,
    sourcemap: true,
    target: ["es2020"],
    legalComments: "none",
    banner: { js: banner },
    footer: artifact.format === "iife"
      ? { js: "globalThis.OrihonReady=Promise.resolve(Orihon);" }
      : undefined
  });
}

const sizes = Object.fromEntries(await Promise.all(artifacts.map(async ({ file }) => {
  const contents = await readFile(resolve(dist, file));
  return [file, { bytes: contents.length, gzipBytes: gzipSync(contents).length }];
})));

await writeFile(manifestPath, JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  module: "index.js",
  core: "core.js",
  standard: "standard.js",
  bundledModule: "orihon.esm.js",
  global: "orihon.global.js",
  css: "orihon.css",
  sizes
}, null, 2));
