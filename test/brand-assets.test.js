import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const productionAssets = [
  "assets/brand/svg/orihon-logo-horizontal.svg",
  "assets/brand/svg/orihon-logo-reversed.svg",
  "assets/brand/svg/orihon-mark.svg",
  "assets/brand/svg/orihon-favicon.svg",
  "assets/brand/png/orihon-logo-horizontal-600.png",
  "assets/brand/png/orihon-favicon-180.png",
  "assets/brand/tokens/orihon-tokens.css",
  "assets/brand/tokens/orihon-tokens.json"
];

test("brand assets are published through the package", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.exports["./brand/*"], "./assets/brand/*");
  assert.ok(pkg.files.includes("assets/brand"));
  await Promise.all(productionAssets.map((path) => access(new URL(path, root))));
});

test("published SVG artwork has no active or remote content", async () => {
  const paths = productionAssets.filter((path) => path.endsWith(".svg"));
  const source = (await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /<script|<foreignObject|javascript:|data:/i);
  assert.doesNotMatch(source, /(?:href|src)=["']https?:/i);
});

test("main documentation and examples render the packaged logo", async () => {
  const [readme, showcase, bench] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("examples/showcase/index.html", root), "utf8"),
    readFile(new URL("examples/bench-compare/index.html", root), "utf8")
  ]);
  assert.match(readme, /assets\/brand\/svg\/orihon-logo-horizontal\.svg/);
  assert.match(showcase, /assets\/brand\/svg\/orihon-logo-horizontal\.svg/);
  assert.match(bench, /assets\/brand\/svg\/orihon-logo-reversed\.svg/);
  assert.match(bench, /assets\/brand\/svg\/orihon-favicon\.svg/);
});
