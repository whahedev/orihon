import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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

// `tsc` does not prune outputs for deleted sources. Never publish retired heat
// renderers or the former long-named pipeline beside the unified heat API.
const obsoleteHeatModules = [
  "layers/heat-layer",
  "layers/webgl-heat-layer",
  "layers/heat-isoline-layer",
  "services/heat-scale",
  "layers/heat-pipeline-layer",
  "services/heat-pipeline",
  "services/heat-pipeline-worker"
];
const obsoleteGpuTileModules = ["layers/webgl-tile-layer", "layers/webgpu-tile-layer"];
const obsoletePublicModules = ["layers/canvas-base-layer"];
for (const modulePath of [...obsoleteHeatModules, ...obsoleteGpuTileModules, ...obsoletePublicModules]) {
  for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
    await unlink(resolve(dist, `${modulePath}${suffix}`)).catch(() => {});
  }
}

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
  // These are public names exported by embedded WASM modules, not JS-private fields.
  // Renaming `__heap_base` makes the one-file browser bundle silently fall back to JS.
  reserved: ["_unsub", "__heap_base", "__data_end"]
};

async function terserMinifyFile(filePath, { module, mangleProperties = true }) {
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
    // Public getters and external modules rely on actual booleans (=== true),
    // so do not rewrite them to 0/1 in any published artifact.
    compress: { passes: 8, keep_fargs: false },
    mangle: {
      properties: mangleProperties ? terserPropertyMangle : false
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
    split: true,
    // Compress boundary validation while preserving property names used by plugins
    // and application objects.
    terser: true,
    mangleProperties: false
  },
  { entry: "advanced-entry.ts", file: "orihon.esm.js", format: "esm", split: true },
  { entry: "object-manager-entry.ts", file: "orihon.object-manager.esm.js", format: "esm", terser: true },
  { entry: "locales-entry.ts", file: "orihon.locales.esm.js", format: "esm", terser: true },
  { entry: "controls.ts", file: "orihon.controls.esm.js", format: "esm", bundle: false },
  { entry: "geo-entry.ts", file: "orihon.geo.esm.js", format: "esm", bundle: false },
  { entry: "popup-content.ts", file: "orihon.popup-content.esm.js", format: "esm", bundle: false },
  { entry: "draw/index.ts", file: "orihon.draw.esm.js", format: "esm", peerExternal: true },
  { entry: "react/index.ts", file: "orihon.react.esm.js", format: "esm", external: ["react", "react-dom/client"] },
  { entry: "react/object-manager.ts", file: "orihon.react-object-manager.esm.js", format: "esm", external: ["react"] },
  { entry: "advanced-entry.ts", file: "orihon.global.js", format: "iife", globalName: "Orihon", terser: true }
];

const chunkFiles = [];

function alternateChunkName(name, attempt) {
  const suffix = attempt === 1 ? "-copy" : `-copy${attempt}`;
  if (name.endsWith(".js.map")) return name.replace(/\.js\.map$/, `${suffix}.js.map`);
  return name.replace(/(\.[^.]+)$/, `${suffix}$1`);
}

for (const artifact of artifacts) {
  if (artifact.split) {
    const outdir = resolve(dist, "bundle-tmp");
    await mkdir(outdir, { recursive: true });
    const entryName = artifact.file.replace(/\.js$/, "");
    const result = await build({
      entryPoints: { [entryName]: resolve(root, "src", artifact.entry) },
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
    const artifactChunks = [];
    for (const name of written) {
      const from = join(outdir, name);
      const to = join(dist, name);
      let destName = name;
      try {
        await copyFile(from, to);
      } catch (err) {
        if (!err || (err.code !== "EPERM" && err.code !== "EACCES")) throw err;
        let copied = false;
        for (let attempt = 1; attempt <= 32; attempt++) {
          destName = alternateChunkName(name, attempt);
          try {
            await copyFile(from, join(dist, destName));
            copied = true;
            break;
          } catch (copyErr) {
            if (!copyErr || (copyErr.code !== "EPERM" && copyErr.code !== "EACCES")) throw copyErr;
          }
        }
        if (!copied) throw new Error(`Unable to replace locked browser chunk: ${name}`);
        if (name.endsWith(".js")) renamed.push([name, destName]);
      }
      if (destName.startsWith("orihon-") && destName.endsWith(".js") && destName !== "orihon.esm.js") {
        if (!chunkFiles.includes(destName)) chunkFiles.push(destName);
        artifactChunks.push(destName);
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

    await terserMinifyFile(resolve(dist, artifact.file), {
      module: true,
      mangleProperties: artifact.mangleProperties ?? true
    });
    for (const chunk of artifactChunks) {
      await terserMinifyFile(resolve(dist, chunk), {
        module: true,
        mangleProperties: artifact.mangleProperties ?? true
      });
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
    await terserMinifyFile(resolve(dist, artifact.file), { module: artifact.format === "esm", mangleProperties: artifact.mangleProperties });
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

const staticImports = {};
for (const file of sizeTargets) {
  const source = await readFile(resolve(dist, file), "utf8");
  staticImports[file] = [...source.matchAll(/(?:^|;)import(?:[^;]*?from)?["']\.\/([^"']+\.js)["']/gm)]
    .map((match) => match[1])
    .filter((dependency) => dependency in sizes);
}

function staticClosure(entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.pop();
    for (const dependency of staticImports[current] ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push(dependency);
    }
  }
  return [...seen];
}

const initialLoads = Object.fromEntries(artifacts.map(({ file }) => {
  const files = staticClosure(file);
  return [file, {
    files,
    bytes: files.reduce((total, dependency) => total + sizes[dependency].bytes, 0),
    gzipBytes: files.reduce((total, dependency) => total + sizes[dependency].gzipBytes, 0)
  }];
}));

await writeFile(manifestPath, JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  module: "standard.js",
  core: "core.js",
  standard: "standard.js",
  advanced: "advanced-entry.js",
  objectManager: "object-manager-entry.js",
  locales: "locales-entry.js",
  controls: "controls.js",
  geo: "geo-entry.js",
  popupContent: "popup-content.js",
  bundledModule: "orihon.esm.js",
  chunks: chunkFiles,
  global: "orihon.global.js",
  css: "orihon.css",
  sizes,
  staticImports,
  initialLoads
}, null, 2));
