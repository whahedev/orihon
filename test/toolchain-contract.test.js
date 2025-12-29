import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("Node policy and GitHub workflows stay on the documented runtimes", async () => {
  const [nodeVersion, packageSource, development, ci, pages] = await Promise.all([
    readFile(new URL(".node-version", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("docs/DEVELOPMENT.md", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(new URL(".github/workflows/pages.yml", root), "utf8")
  ]);
  const pinned = nodeVersion.trim();
  const pkg = JSON.parse(packageSource);
  assert.equal(pkg.engines.node, ">=22.0.0");
  assert.match(pinned, /^24\./);
  assert.match(development, new RegExp(pinned.replaceAll(".", "\\.")));
  assert.match(ci, /node-version: 22/);
  assert.match(ci, /node-version: 24/);
  assert.match(pages, /node-version: "24"/);
  assert.doesNotMatch(`${ci}\n${pages}`, /actions\/(?:checkout|setup-node)@v[1-5]\b/);
  assert.doesNotMatch(ci, /actions\/upload-artifact@v[1-6]\b/);
  assert.doesNotMatch(pages, /actions\/upload-pages-artifact@v[1-4]\b/);
});
