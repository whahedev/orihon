import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const stageRoot = resolve(root, "_publish_stage");
const out = resolve(stageRoot, "orihon-dist");
if (relative(stageRoot, out).startsWith(`..${sep}`)) {
  throw new Error(`Refusing to stage outside ${stageRoot}`);
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

async function copyInto(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(dist, "release-manifest.json"), "utf8"));
const browserFiles = Object.keys(manifest.sizes ?? {}).filter((file) => file.endsWith(".js"));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of [...browserFiles, "orihon.css", "draw.css"]) {
  await copyInto(resolve(dist, file), resolve(out, file));
}
for (const source of (await walk(dist)).filter((path) => path.endsWith(".d.ts"))) {
  await copyInto(source, resolve(out, relative(dist, source)));
}
for (const name of ["LICENSE", "LICENSE-NOTICE.md"]) {
  await copyInto(resolve(root, name), resolve(out, name));
}

const readme = `# Orihon ${pkg.version} (browser distribution)

Prebuilt, minified browser/CDN artifacts. The default ESM and script-tag builds
contain the explicit Advanced surface; ObjectManager, extra locales and their
React binding are separate opt-in files.

## Entries

| Import | Use |
| --- | --- |
| \`orihon-dist\` | Advanced ESM entry |
| \`orihon-dist/standard\` | Standard map API |
| \`orihon-dist/core\` | Core primitives |
| \`orihon-dist/object-manager\` | ObjectManager APIs |
| \`orihon-dist/locales\` | Non-English locale packs |
| \`orihon-dist/react\` | Base React bindings |
| \`orihon-dist/react/object-manager\` | React ObjectManager binding |
| \`orihon-dist/global\` | Script-tag build → \`Orihon\` / \`OrihonReady\` |

## Script tag

\`\`\`html
<link rel="stylesheet" href="./orihon.css" />
<script src="./orihon.global.js"></script>
<script>
  const map = Orihon.createMap("map", { center: [52.52, 13.405], zoom: 10 });
</script>
\`\`\`

## License

Apache License 2.0 — see \`LICENSE\` and \`LICENSE-NOTICE.md\`.
Copyright 2026 whahe.
`;

await writeFile(resolve(out, "README.md"), readme);

const exports = {
  ".": { types: "./advanced-entry.d.ts", import: "./orihon.esm.js" },
  "./advanced": { types: "./advanced-entry.d.ts", import: "./orihon.esm.js" },
  "./core": { types: "./core.d.ts", import: "./orihon.core.esm.js" },
  "./standard": { types: "./standard.d.ts", import: "./orihon.standard.esm.js" },
  "./object-manager": { types: "./object-manager-entry.d.ts", import: "./orihon.object-manager.esm.js" },
  "./locales": { types: "./locales-entry.d.ts", import: "./orihon.locales.esm.js" },
  "./controls": { types: "./controls.d.ts", import: "./orihon.controls.esm.js" },
  "./geo": { types: "./geo-entry.d.ts", import: "./orihon.geo.esm.js" },
  "./popup-content": { types: "./popup-content.d.ts", import: "./orihon.popup-content.esm.js" },
  "./draw": { types: "./draw/index.d.ts", import: "./orihon.draw.esm.js" },
  "./react": { types: "./react/index.d.ts", import: "./orihon.react.esm.js" },
  "./react/object-manager": { types: "./react/object-manager.d.ts", import: "./orihon.react-object-manager.esm.js" },
  "./global": "./orihon.global.js",
  "./orihon.css": "./orihon.css",
  "./draw.css": "./draw.css",
  "./package.json": "./package.json"
};

await writeFile(resolve(out, "package.json"), `${JSON.stringify({
  name: "orihon-dist",
  version: pkg.version,
  description: "Prebuilt Orihon browser map library artifacts.",
  type: "module",
  main: "./orihon.global.js",
  module: "./orihon.esm.js",
  types: "./advanced-entry.d.ts",
  exports,
  license: "Apache-2.0",
  files: ["**/*.js", "**/*.d.ts", "*.css", "LICENSE", "LICENSE-NOTICE.md", "README.md"],
  sideEffects: ["./orihon.css", "./draw.css", "./orihon.esm.js", "./orihon.locales.esm.js"],
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
  keywords: ["orihon", "map", "gis", "browser", "cdn"],
  private: false
}, null, 2)}\n`);

console.log(`Wrote compiled distribution -> ${out}`);
