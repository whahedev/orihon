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
