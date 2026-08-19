import { readFile } from "node:fs/promises";
const js = await readFile("dist/orihon.esm.js", "utf8");
console.log("quoted _unsub", (js.match(/"_unsub"/g) || []).length);
console.log("this._unsub", (js.match(/this\._unsub/g) || []).length);
console.log("this.M.push", (js.match(/this\.M\.push/g) || []).length);
console.log("createMap export", js.includes("createMap"));
