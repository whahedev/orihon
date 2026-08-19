import { build } from "esbuild";
import { gzipSync } from "zlib";
import { resolve } from "path";
import { writeFileSync } from "fs";

const root = resolve(".");
const result = await build({
  entryPoints: [resolve(root, "dist/index.js")],
  bundle: true,
  write: false,
  format: "esm",
  minify: true,
  metafile: true,
  target: ["es2022"],
  legalComments: "none"
});
const code = result.outputFiles[0].contents;
console.log("bundled", code.length, "gz", gzipSync(code, { level: 9 }).length);
const inputs = Object.entries(result.metafile.inputs)
  .map(([path, info]) => ({
    path: path.replace(/\\/g, "/").replace(/^.*?dist\//, "dist/"),
    bytes: info.bytesInOutput ?? 0,
    bytesIn: info.bytes
  }))
  .filter((x) => x.bytes > 0)
  .sort((a, b) => b.bytes - a.bytes);
console.log(
  inputs
    .slice(0, 45)
    .map((i) => String(i.bytes).padStart(7) + " out  " + String(i.bytesIn).padStart(7) + " in  " + i.path)
    .join("\n")
);
const groups = {};
for (const i of inputs) {
  const p = i.path;
  let g = "other";
  if (p.includes("/webgl-")) g = "webgl-layers";
  else if (p.includes("/object-")) g = "object-*";
  else if (p.includes("/services/")) g = "services-other";
  else if (p.includes("/layers/")) g = "layers-other";
  else if (p.includes("/ui/")) g = "ui";
  else if (p.includes("/overlays/")) g = "overlays";
  else if (
    /\/(map|geo|dom|events|layer|renderer|crs|layer-group|index|webgl-utils)\.js$/.test(p)
  ) {
    g = "coreish";
  }
  groups[g] = (groups[g] || 0) + i.bytes;
}
console.log("--- groups out ---");
console.log(
  Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => String(v).padStart(7) + " " + k)
    .join("\n")
);
writeFileSync("tmp-metafile.json", JSON.stringify(result.metafile));
