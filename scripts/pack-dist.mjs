import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(root, "orihon-dist");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const artifacts = [
  "orihon.css",
  "orihon.core.esm.js",
  "orihon.standard.esm.js",
  "orihon.esm.js",
  "orihon.global.js",
  "index.d.ts",
  "core.d.ts",
  "standard.d.ts"
];

const manifest = JSON.parse(await readFile(join(dist, "release-manifest.json"), "utf8"));
const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
for (const chunk of chunks) artifacts.push(chunk);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of artifacts) {
  await copyFile(join(dist, file), join(out, file));
}

await copyFile(join(root, "LICENSE"), join(out, "LICENSE"));
await copyFile(join(root, "LICENSE-NOTICE.md"), join(out, "LICENSE-NOTICE.md"));

const readme = `# Orihon ${pkg.version} (compiled)

Prebuilt browser/CDN artifacts from the \`orihon\` package root.

## Files

| File | Use |
| --- | --- |
| \`orihon.global.js\` | \`<script>\` → \`Orihon\` / \`OrihonReady\` |
| \`orihon.esm.js\` | Advanced ESM entry (loads \`orihon-*.js\` chunks on demand) |
| \`orihon.standard.esm.js\` | Standard tier ESM bundle |
| \`orihon.core.esm.js\` | Core tier ESM bundle |
| \`orihon.css\` | Stylesheet |
| \`*.d.ts\` | TypeScript entry declarations |

## Script tag

\`\`\`html
<link rel="stylesheet" href="./orihon.css" />
<script src="./orihon.global.js"></script>
<script>
  const map = Orihon.createMap("map", { center: [52.52, 13.405], zoom: 10 });
</script>
\`\`\`

## ESM

\`\`\`js
import { createMap, tileLayer } from "./orihon.esm.js";
\`\`\`

## License

Apache License 2.0 — see \`LICENSE\` and \`LICENSE-NOTICE.md\`.
Copyright 2026 whahe.
`;

await writeFile(join(out, "README.md"), readme);

await writeFile(join(out, "package.json"), JSON.stringify({
  name: "orihon-dist",
  version: pkg.version,
  description: "Prebuilt Orihon map library artifacts (no source).",
  type: "module",
  main: "./orihon.global.js",
  module: "./orihon.esm.js",
  types: "./index.d.ts",
  license: "Apache-2.0",
  files: [
    "orihon.css",
    "orihon.core.esm.js",
    "orihon.standard.esm.js",
    "orihon.esm.js",
    "orihon.global.js",
    "orihon-*.js",
    "index.d.ts",
    "core.d.ts",
    "standard.d.ts",
    "LICENSE",
    "LICENSE-NOTICE.md",
    "README.md"
  ],
  sideEffects: ["./orihon.css"],
  keywords: ["orihon", "map", "gis"],
  private: false
}, null, 2) + "\n");

console.log(`Wrote compiled distribution → ${out}`);
