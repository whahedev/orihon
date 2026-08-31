import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "../packages/create-orihon-app/index.mjs";

const VITE_TEMPLATES = [
  ["vanilla", "src/main.js"],
  ["vanilla-ts", "src/main.ts"],
  ["react", "src/App.jsx"],
  ["react-ts", "src/App.tsx"]
];

const ALL_TEMPLATES = ["vanilla", "vanilla-ts", "react", "react-ts", "cdn"];

async function scaffold(argv) {
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  const result = await create(argv, { cwd: root, interactive: false, log: () => {} });
  return { root, result };
}

async function read(directory, file) {
  return readFile(join(directory, file), "utf8");
}

function assertEasySurface(source) {
  assert.match(source, /createMap\b/);
  assert.match(source, /OpenStreetMap contributors/);
  assert.match(source, /addMarker\b/);
  assert.match(source, /addPolyline\b/);
  assert.match(source, /addPolygon\b/);
  assert.match(source, /addGeoJSON\b/);
  assert.match(source, /addTileLayer\b/);
  assert.match(source, /circleMarker\b/);
  assert.match(source, /circle\b/);
  assert.match(source, /rectangle\b/);
  assert.match(source, /textLayer\b/);
  assert.match(source, /imageOverlay\b/);
  assert.match(source, /videoOverlay\b/);
  assert.match(source, /featureGroup\b/);
  assert.match(source, /pointToLayer/);
  assert.match(source, /bindPopup/);
  assert.match(source, /interactive-examples\.mdn\.mozilla\.net/);
  assert.match(source, /data:image\/svg\+xml/);
  assert.match(source, /Delete any block|Edit or delete/i);
}

for (const [template, entry] of VITE_TEMPLATES) {
  test(`${template}: the generated project draws an attributed Easy map`, async () => {
    const { root, result } = await scaffold([
      "my-map",
      "--template",
      template,
      "--yes",
      "--center",
      "55.75,37.62",
      "--locale",
      "en"
    ]);
    try {
      assert.equal(result.template, template);
      assert.equal(result.name, "my-map");
      assert.deepEqual(result.center, { lat: 55.75, lng: 37.62 });
      assert.equal(result.locale, "en");

      const source = await read(result.directory, entry);
      const css = await read(result.directory, "src/style.css");
      const styleImport =
        template.startsWith("react")
          ? await read(result.directory, template === "react" ? "src/main.jsx" : "src/main.tsx")
          : source;

      assert.match(styleImport, /import "orihon\/orihon\.css"/);
      assert.match(css, /height:\s*100vh/);
      assert.match(css, /min-height:\s*360px/);
      assertEasySurface(source);
      assert.match(source, /55\.75/);
      assert.match(source, /37\.62/);
      assert.match(source, /"en"/);
      assert.equal(source.match(/createMap\s*\(/g)?.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${template}: the manifest installs orihon and opens on vite`, async () => {
    const { root, result } = await scaffold(["my-map", "--template", template, "--yes"]);
    try {
      const manifest = JSON.parse(await read(result.directory, "package.json"));
      assert.equal(manifest.name, "my-map");
      assert.equal(manifest.type, "module");
      assert.ok(manifest.dependencies.orihon, "orihon is a dependency");
      assert.match(manifest.dependencies.orihon, /^\^\d+\.\d+\.\d+/);
      assert.equal(manifest.scripts.dev, "vite --open");
      assert.equal(manifest.scripts.build, template.endsWith("-ts") ? "tsc --noEmit && vite build" : "vite build");
      const html = await read(result.directory, "index.html");
      assert.match(html, /<div id="(map|root)"><\/div>/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("cdn: single HTML file with Easy samples and pinned CDN version", async () => {
  const { root, result } = await scaffold(["my-map", "--template", "cdn", "--yes", "--center", "1,2"]);
  try {
    assert.equal(result.template, "cdn");
    const html = await read(result.directory, "index.html");
    assertEasySurface(html);
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/orihon@\d+\.\d+\.\d+\//);
    assert.doesNotMatch(html, /__ORIHON_/);
    assert.match(html, /\b1\b/);
    assert.match(html, /\b2\b/);
    const entries = await readdir(result.directory);
    assert.ok(!entries.includes("package.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("a bad --center is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  try {
    await assert.rejects(
      create(["my-map", "--yes", "--center", "not-a-point"], { cwd: root, interactive: false, log: () => {} }),
      /Invalid --center/
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
  for (const template of ALL_TEMPLATES) assert.match(help, new RegExp(template));
  assert.match(help, /--install/);
  assert.match(help, /--center/);
});

test("running the file as a command scaffolds and reports where", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  try {
    const cli = fileURLToPath(new URL("../packages/create-orihon-app/index.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, "cli-app", "--template", "vanilla", "--yes"],
      { cwd: root }
    );
    assert.match(stdout, /Created cli-app in /);
    assert.match(stdout, /npm run dev/);
    assert.match(stdout, /Easy API/);
    assert.match(await read(join(root, "cli-app"), "src/main.js"), /createMap\("map"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command exits non-zero on a bad template instead of doing nothing", async () => {
  const { execFile } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "orihon-create-"));
  try {
    const cli = fileURLToPath(new URL("../packages/create-orihon-app/index.mjs", import.meta.url));
    const failure = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cli, "nope", "--template", "svelte", "--yes"],
        { cwd: root },
        (error, stdout, stderr) => resolve({ code: error?.code, stderr })
      );
    });
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Unknown template "svelte"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
