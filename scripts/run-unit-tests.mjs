import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => join(testDir, name))
  .sort();

if (!files.length) {
  console.error(`No *.test.js files found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);
