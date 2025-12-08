import test from "node:test";
import assert from "node:assert/strict";
import { WTinyLfu, CountMinSketch, wTinyLfu } from "../dist/services/tiny-lfu.js";

test("W-TinyLFU admits frequent keys over one-shot window candidates", () => {
  const cache = wTinyLfu(4, { windowRatio: 0.25 });
  cache.add("hot");
  for (let i = 0; i < 8; i++) cache.hit("hot");
  const evicted = [];
  for (const key of ["a", "b", "c", "d", "e"]) {
    const victim = cache.add(key);
    if (victim) evicted.push(victim);
  }
  assert.equal(cache.has("hot"), true);
  assert.ok(!evicted.includes("hot"));
  assert.equal(cache.size, 4);
});

test("W-TinyLFU hit refreshes recency and optional trace records ops", () => {
  const cache = new WTinyLfu(3, { trace: true, windowRatio: 0.5 });
  cache.add("a");
  cache.add("b");
  cache.hit("a");
  const victim = cache.add("c");
  assert.ok(victim === "b" || victim === undefined || cache.has("a"));
  assert.equal(cache.has("a"), true);
  assert.ok(cache.trace?.some((entry) => entry.op === "hit" && entry.key === "a"));
});

test("Count-Min sketch ages counters", () => {
  const sketch = new CountMinSketch(32, 2, 256);
  for (let i = 0; i < 300; i++) sketch.hit("k");
  const after = sketch.estimate("k");
  assert.ok(after > 0);
  assert.ok(after < 255);
});
