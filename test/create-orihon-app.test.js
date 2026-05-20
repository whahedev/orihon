import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "../packages/create-orihon-app/index.mjs";

// The starter is the consumer flow: whatever it writes is what a first-time user runs. These
// assertions are the four things a blank map is usually missing, checked in the generated files
// rather than in prose telling someone to remember them.
async function scaffold(argv) {
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  const result = await create(argv, { cwd: root, interactive: false, log: () => {} });
  return { root, result };
}

async function read(directory, file) {
  return readFile(join(directory, file), "utf8");
}

for (const [template, entry] of [["vanilla", "src/main.js"], ["react", "src/App.jsx"]]) {
  test(`${template}: the generated project draws one attributed map`, async () => {
    const { root, result } = await scaffold(["my-map", "--template", template, "--yes"]);
    try {
      assert.equal(result.template, template);
      assert.equal(result.name, "my-map");

      const source = await read(result.directory, entry);
      const css = await read(result.directory, "src/style.css");
      const styleImport = template === "react" ? await read(result.directory, "src/main.jsx") : source;

      // 1. the stylesheet, which is silently missing from most first attempts
      assert.match(styleImport, /import "orihon\/orihon\.css"/);
      // 2. a container with a real height
      assert.match(css, /height:\s*100vh/);
      assert.match(css, /min-height:\s*360px/);
      // 3. credit for the tile provider
      assert.match(source, /OpenStreetMap contributors/);
      // 4. exactly one map
      assert.equal(source.match(/createMap\(|<Map\b/g)?.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${template}: the manifest installs orihon and runs on vite`, async () => {
    const { root, result } = await scaffold(["my-map", "--template", template, "--yes"]);
    try {
      const manifest = JSON.parse(await read(result.directory, "package.json"));
      assert.equal(manifest.name, "my-map");
      assert.equal(manifest.type, "module");
      assert.ok(manifest.dependencies.orihon, "orihon is a dependency");
      assert.equal(manifest.scripts.dev, "vite");
      assert.equal(manifest.scripts.build, "vite build");
      const html = await read(result.directory, "index.html");
      assert.match(html, /<div id="(map|root)"><\/div>/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("the directory name becomes a legal package name", async () => {
  const { root, result } = await scaffold(["My Map!", "--template", "vanilla", "--yes"]);
  try {
    const manifest = JSON.parse(await read(result.directory, "package.json"));
    assert.equal(manifest.name, "my-map");
    assert.doesNotMatch(manifest.name, /[A-Z\s!]|^[-_.]|[-_.]$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the ignore file ships under a name npm publishes, and lands as .gitignore", async () => {
  const { root, result } = await scaffold(["my-map", "--template", "vanilla", "--yes"]);
  try {
    const entries = await readdir(result.directory);
    assert.ok(entries.includes(".gitignore"), "project has a .gitignore");
    assert.ok(!entries.includes("_gitignore"), "the shipped placeholder is not left behind");
    assert.match(await read(result.directory, ".gitignore"), /node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown template is refused by name instead of scaffolding something else", async () => {
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  try {
    await assert.rejects(
      create(["my-map", "--template", "svelte", "--yes"], { cwd: root, interactive: false, log: () => {} }),
      /Unknown template "svelte"/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory with files in it is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  try {
    await mkdir(join(root, "taken"), { recursive: true });
    await writeFile(join(root, "taken", "notes.txt"), "mine", "utf8");
    await assert.rejects(
      create(["taken", "--yes"], { cwd: root, interactive: false, log: () => {} }),
      /already exists and is not empty/
    );
    assert.equal(await read(join(root, "taken"), "notes.txt"), "mine");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every template is listed in the help and reachable by name", async () => {
  const lines = [];
  await create(["--help"], { cwd: tmpdir(), interactive: false, log: (line) => lines.push(line) });
  const help = lines.join("\n");
  assert.match(help, /npm create orihon-app/);
  for (const template of ["vanilla", "react"]) assert.match(help, new RegExp(template));
});
