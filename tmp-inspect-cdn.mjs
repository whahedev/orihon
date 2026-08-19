import { readFile } from "node:fs/promises";
const js = await readFile("tmp-orihon-cdn.js", "utf8");

// Map class field inits
const idx = js.indexOf('h(this,"_viewSession"');
console.log(js.slice(idx, idx + 350));

console.log("\n--- this.M usages (first 10) ---");
let i = 0, n = 0;
while ((i = js.indexOf("this.M", i)) !== -1 && n < 15) {
  console.log(n, js.slice(i, i + 40));
  i++; n++;
}

console.log("\n--- _unsub string still present? ---", (js.match(/"_unsub"/g) || []).length);
console.log("--- this._unsub? ---", (js.match(/this\._unsub/g) || []).length);
