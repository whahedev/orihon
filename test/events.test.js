import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";

test("Evented emits and unsubscribes handlers", () => {
  const evented = new Evented();
  let count = 0;
  const handler = () => count++;
  evented.on("ping", handler);
  evented.emit("ping");
  evented.off("ping", handler);
  evented.emit("ping");
  assert.equal(count, 1);
});

test("Evented once runs once", () => {
  const evented = new Evented();
  let count = 0;
  evented.once("ping", () => count++);
  evented.emit("ping");
  evented.emit("ping");
  assert.equal(count, 1);
});

test("Evented flattens payload fields and protects event metadata", () => {
  const target = new Evented();
  const payload = { value: 42, type: "fake", target: "fake", sourceTarget: "fake" };
  target.on("ready", (event) => {
    assert.equal(event.type, "ready");
    assert.equal(event.target, target);
    assert.equal(event.sourceTarget, target);
    assert.equal(event.value, 42);
    assert.equal("detail" in event, false);
  });
  target.emit("ready", payload);
});

test("Evented distinguishes the current target from the original propagated source", () => {
  const child = new Evented(), parent = new Evented(), grandparent = new Evented();
  child.addEventParent(parent);
  parent.addEventParent(grandparent);
  const events = [];
  for (const instance of [child, parent, grandparent]) instance.on("ready", (event) => events.push(event));
  child.emit("ready", { value: 7 });
  assert.deepEqual(events.map((event) => event.target), [child, parent, grandparent]);
  assert.ok(events.every((event) => event.sourceTarget === child && event.value === 7));
  assert.equal(events[1].propagatedFrom, child);
  assert.equal(events[2].propagatedFrom, parent);
  assert.equal(events[2].layer, child);
  child.removeEventParent(parent).emit("ready");
  assert.equal(events.length, 4);
});

test("Evented once unsubscribes before reentrant dispatch and off keeps callback identity", () => {
  const target = new Evented();
  let once = 0, persistent = 0;
  const callback = () => persistent++;
  target.on("ready", callback).on("ready", callback);
  target.once("ready", () => { once++; target.emit("ready"); });
  target.emit("ready");
  assert.equal(once, 1);
  assert.equal(persistent, 2);
  target.off("ready", callback).emit("ready");
  assert.equal(persistent, 2);
  target.on("ready", callback).on("other", callback).off().emit("ready").emit("other");
  assert.equal(persistent, 2);
});
