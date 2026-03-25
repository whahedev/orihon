import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import { mergeOptions } from "../dist/units.js";
import { objectManager } from "../dist/services/object-manager.js";

/** Captures what `emit` reports instead of letting it reach the real console. */
function captureReportedErrors(run) {
  const seen = [];
  const realReport = globalThis.reportError;
  const realConsoleError = console.error;
  globalThis.reportError = (error) => seen.push(error);
  console.error = (error) => seen.push(error);
  try {
    run();
  } finally {
    if (realReport === undefined) delete globalThis.reportError;
    else globalThis.reportError = realReport;
    console.error = realConsoleError;
  }
  return seen;
}

test("a throwing listener does not abort the remaining handlers", () => {
  const source = new Evented();
  const ran = [];
  source.on("t", () => { ran.push("first"); throw new Error("boom"); });
  source.on("t", () => ran.push("second"));

  // emit runs inside the render loop: it must not unwind into the caller.
  captureReportedErrors(() => assert.doesNotThrow(() => source.emit("t", {})));
  assert.deepEqual(ran, ["first", "second"]);
});

test("a listener failure is still surfaced to the host environment", () => {
  const source = new Evented();
  source.on("t", () => { throw new Error("surfaced"); });

  const seen = captureReportedErrors(() => source.emit("t", {}));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, "surfaced");
});

test("cyclic event parents propagate once instead of overflowing the stack", () => {
  const a = new Evented();
  const b = new Evented();
  a.addEventParent(b);
  b.addEventParent(a);

  let onA = 0;
  let onB = 0;
  a.on("x", () => onA++);
  b.on("x", () => onB++);

  assert.doesNotThrow(() => a.emit("x", {}));
  assert.equal(onA, 1);
  assert.equal(onB, 1);
});

test("a three-node parent cycle also terminates", () => {
  const [a, b, c] = [new Evented(), new Evented(), new Evented()];
  a.addEventParent(b);
  b.addEventParent(c);
  c.addEventParent(a);
  let hits = 0;
  for (const node of [a, b, c]) node.on("x", () => hits++);
  assert.doesNotThrow(() => a.emit("x", {}));
  assert.equal(hits, 3);
});

test("off(type, handler) cancels a pending once subscription", () => {
  const source = new Evented();
  let ran = 0;
  const handler = () => ran++;
  source.once("z", handler);
  source.off("z", handler);
  source.emit("z", {});
  assert.equal(ran, 0);
});

test("once still fires exactly once and off() after it is a no-op", () => {
  const source = new Evented();
  let ran = 0;
  const handler = () => ran++;
  source.once("z", handler);
  source.emit("z", {});
  source.emit("z", {});
  assert.equal(ran, 1);
  assert.doesNotThrow(() => source.off("z", handler));
});

test("mergeOptions ignores keys explicitly set to undefined", () => {
  const merged = mergeOptions({ zoom: 3, label: "a" }, { zoom: undefined, label: "b" });
  assert.equal(merged.zoom, 3);
  assert.equal(merged.label, "b");
  assert.deepEqual(mergeOptions({ zoom: 3 }, undefined), { zoom: 3 });
  // A deliberate null is a value, not an omission.
  assert.equal(mergeOptions({ style: {} }, { style: null }).style, null);
});

test("constructors accept optional props passed through as undefined", () => {
  // React and conditional spreads produce `{ key: undefined }` constantly; that
  // must read as "not supplied" rather than overwriting the default with NaN.
  const manager = objectManager({
    clusterRadiusPixels: undefined,
    clusterMinPoints: undefined,
    webglThreshold: undefined,
    maxObjects: undefined
  });
  assert.equal(manager.options.clusterRadiusPixels, 50);
  assert.equal(manager.options.clusterMinPoints, 2);
  assert.equal(manager.options.webglThreshold, 2000);
  manager.destroy();
});
