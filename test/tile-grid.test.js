import test from "node:test";
import assert from "node:assert/strict";
import { forEachTileRectDelta, forEachMissingNeeded, parseTileKey, tilePriority, MinHeap } from "../dist/layers/tile-grid.js";

test("tile coverage delta visits only enter/leave strips", () => {
  const prev = { z: 8, left: 10, top: 20, right: 12, bottom: 22 };
  const next = { z: 8, left: 11, top: 20, right: 13, bottom: 22 };
  const entered = [];
  const left = [];
  forEachTileRectDelta(prev, next, (x, y) => entered.push(`${x}:${y}`), (x, y) => left.push(`${x}:${y}`));
  assert.deepEqual(left.sort(), ["10:20", "10:21", "10:22"]);
  assert.deepEqual(entered.sort(), ["13:20", "13:21", "13:22"]);
});

test("tilePriority prefers tiles in the pan direction", () => {
  const toward = tilePriority(7, 5, 5, 5, 2000, 0, 256);
  const away = tilePriority(3, 5, 5, 5, 2000, 0, 256);
  assert.ok(toward < away);
});

test("MinHeap pops the lowest score first", () => {
  const heap = new MinHeap((item) => item.n);
  heap.push({ n: 3 });
  heap.push({ n: 1 });
  heap.push({ n: 2 });
  assert.equal(heap.pop()?.n, 1);
  assert.equal(heap.pop()?.n, 2);
  assert.equal(heap.pop()?.n, 3);
  assert.equal(heap.pop(), undefined);
});

test("parseTileKey reads z:x:y including negatives", () => {
  assert.deepEqual(parseTileKey("8:10:20"), { z: 8, x: 10, y: 20 });
  assert.deepEqual(parseTileKey("3:-1:5"), { z: 3, x: -1, y: 5 });
  assert.equal(parseTileKey("bad"), null);
});

test("forEachMissingNeeded continues fill after a committed coverage rect", () => {
  const needed = new Set(["4:1:1", "4:1:2", "4:2:1", "4:2:2"]);
  const created = new Set(["4:1:1"]);
  const missing = [];
  forEachMissingNeeded(needed, (key) => created.has(key), (x, y, key) => missing.push(key));
  assert.deepEqual(missing.sort(), ["4:1:2", "4:2:1", "4:2:2"]);
});
