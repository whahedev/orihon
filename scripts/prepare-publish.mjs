import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = resolve(root, "_publish_stage");
const out = resolve(stageRoot, "orihon");
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

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const dist = resolve(root, "dist");
for (const source of await walk(dist)) {
  const rel = relative(dist, source);
  const topLevelBrowserArtifact = !rel.includes(sep) && /^orihon(?:[.-].*)?\.js$/.test(rel);
  const publishable = rel.endsWith(".js") || rel.endsWith(".d.ts") || rel.endsWith(".css");
  if (!publishable || topLevelBrowserArtifact) continue;
  await copyInto(source, resolve(out, "dist", rel));
}

for (const folder of ["svg", "tokens"]) {
  const base = resolve(root, "assets", "brand", folder);
  for (const source of await walk(base)) {
    await copyInto(source, resolve(out, "assets", "brand", folder, relative(base, source)));
  }
}

for (const name of ["LICENSE", "LICENSE-NOTICE.md", "README.md", "CHANGELOG.md"]) {
  await copyInto(resolve(root, name), resolve(out, name));
}
for (const source of (await walk(resolve(root, "docs"))).filter((path) => path.endsWith(".md"))) {
  await copyInto(source, resolve(out, "docs", relative(resolve(root, "docs"), source)));
}

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
pkg.sideEffects = pkg.sideEffects.filter((path) => !path.startsWith("./src/"));
pkg.files = ["dist", "assets/brand/svg", "assets/brand/tokens", "docs", "LICENSE", "LICENSE-NOTICE.md", "README.md", "CHANGELOG.md"];
await writeFile(resolve(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Wrote publish-ready modular package -> ${out}`);
