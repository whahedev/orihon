import { readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

async function removeMaps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await removeMaps(path);
    else if (entry.name.endsWith(".map") || entry.name === "release-manifest.json") await unlink(path);
  }
}

await removeMaps(dist);
console.log("stripped source maps from dist for publish");
