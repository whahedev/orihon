import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
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

// Drop stale Advanced code-split chunks from prior builds.
for (const name of await readdir(dist)) {
  if (/^orihon-.+\.js(\.map)?$/.test(name) && name !== "orihon.esm.js" && !name.startsWith("orihon.core")
    && !name.startsWith("orihon.standard") && !name.startsWith("orihon.global")
    && !name.startsWith("orihon.controls") && !name.startsWith("orihon.geo")
    && !name.startsWith("orihon.popup") && !name.startsWith("orihon.draw")
    && !name.startsWith("orihon.react")) {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(dist, name)).catch(() => {});
  }
}

const banner = `/*! Orihon ${pkg.version} | Apache-2.0 | Copyright 2026 whahe */`;

/** Safe property mangling: only rename identifiers matching /^_/ (keeps `_unsub`). */
const terserPropertyMangle = {
  regex: /^_/,
  reserved: ["_unsub"]
};

async function terserMinifyFile(filePath, { module }) {
  const sourceMapPath = `${filePath}.map`;
  let mapContent;
  try {
    mapContent = await readFile(sourceMapPath, "utf8");
  } catch {
    mapContent = undefined;
  }
  const file = filePath.split(/[/\\]/).pop();
  const compact = await minify(await readFile(filePath, "utf8"), {
    module,
    compress: { passes: 8, booleans_as_integers: true, keep_fargs: false },
    mangle: {
      properties: terserPropertyMangle
    },
    format: { comments: /^!/ },
    sourceMap: mapContent
      ? {
          content: mapContent,
          filename: file,
          url: `${file}.map`
        }
      : undefined
  });
  if (!compact.code) throw new Error(`Terser produced no code for ${filePath}`);
  await writeFile(filePath, compact.code);
  if (compact.map) await writeFile(sourceMapPath, compact.map);
}

const artifacts = [
  {
    entry: "core.ts",
    file: "orihon.core.esm.js",
    format: "esm",
    external: ["./services/map-export.js"],
    plugins: [{
      name: "externalize-locale-packs",
      setup(buildApi) {
        buildApi.onResolve({ filter: /[/\\]locale-packs\.js$/ }, () => ({
          path: "./ui/locale-packs.js",
          external: true
        }));
      }
    }]
  },
  {
    entry: "standard.ts",
    file: "orihon.standard.esm.js",
    format: "esm",
    external: ["./services/map-export.js"]
  },
  { entry: "index.ts", file: "orihon.esm.js", format: "esm", split: true },
  { entry: "controls.ts", file: "orihon.controls.esm.js", format: "esm", bundle: false },
  { entry: "geo-entry.ts", file: "orihon.geo.esm.js", format: "esm", bundle: false },
  { entry: "popup-content.ts", file: "orihon.popup-content.esm.js", format: "esm", bundle: false },
  { entry: "draw/index.ts", file: "orihon.draw.esm.js", format: "esm", peerExternal: true },
  { entry: "react/index.ts", file: "orihon.react.esm.js", format: "esm", external: ["react", "react-dom/client"] },
  { entry: "index.ts", file: "orihon.global.js", format: "iife", globalName: "Orihon", terser: true }
];

const chunkFiles = [];

for (const artifact of artifacts) {
  if (artifact.split) {
    const outdir = resolve(dist, "bundle-tmp");
    await mkdir(outdir, { recursive: true });
    const result = await build({
      entryPoints: { "orihon.esm": resolve(root, "src", artifact.entry) },
      outdir,
      entryNames: "[name]",
      chunkNames: "orihon-[name]-[hash]",
      bundle: true,
      splitting: true,
      format: "esm",
      minify: true,
      sourcemap: true,
      target: ["es2022"],
      legalComments: "none",
      banner: { js: banner }
    });
    // Move entry + chunks into dist/. On Windows a previous serve/build can
    // EPERM-lock a hashed chunk; copy to an alternate name and rewrite imports.
    const written = await readdir(outdir);
    const renamed = [];
    for (const name of written) {
      const from = join(outdir, name);
      const to = join(dist, name);
      let destName = name;
      try {
        await copyFile(from, to);
      } catch (err) {
        if (!err || (err.code !== "EPERM" && err.code !== "EACCES")) throw err;
        destName = name.replace(/(\.[^.]+)$/, `-copy$1`);
        await copyFile(from, join(dist, destName));
        if (name.endsWith(".js")) renamed.push([name, destName]);
      }
      if (destName.startsWith("orihon-") && destName.endsWith(".js") && destName !== "orihon.esm.js") {
        chunkFiles.push(destName);
      }
    }
    if (renamed.length) {
      const esmPath = resolve(dist, "orihon.esm.js");
      let src = await readFile(esmPath, "utf8");
      for (const [fromName, toName] of renamed) {
        src = src.replaceAll(`./${fromName}`, `./${toName}`);
      }
      await writeFile(esmPath, src);
    }
    // Cleanup tmp via rewriting — leave files; delete dir contents by moving only
    const { rm } = await import("node:fs/promises");
    await rm(outdir, { recursive: true, force: true });

    await terserMinifyFile(resolve(dist, "orihon.esm.js"), { module: true });
    for (const chunk of chunkFiles) {
      await terserMinifyFile(resolve(dist, chunk), { module: true });
    }
    // Ensure meta outputs tracked
    void result;
    continue;
  }

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
    plugins: [
      ...(artifact.plugins ?? []),
      ...(artifact.peerExternal ? [{
        name: "externalize-orihon-peer",
        setup(buildApi) {
          buildApi.onResolve({ filter: /^\.\.\// }, () => ({ path: "orihon/standard", external: true }));
        }
      }] : [])
    ]
  });

  if (artifact.terser) {
    await terserMinifyFile(resolve(dist, artifact.file), { module: artifact.format === "esm" });
  }
}

const sizeTargets = [
  ...artifacts.map((a) => a.file),
  ...chunkFiles
];

const sizes = Object.fromEntries(await Promise.all(sizeTargets.map(async (file) => {
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
  chunks: chunkFiles,
  global: "orihon.global.js",
  css: "orihon.css",
  sizes
}, null, 2));
