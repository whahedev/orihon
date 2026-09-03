import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createCommandJournal, createPendingCommandTracker } from "../examples/ai-agent-demo/journal.js";

test("AI demo journal renders newest events, caps history and clears", () => {
  const dom = new JSDOM("<!doctype html><div id=log></div>");
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const container = document.querySelector("#log");
    const journal = createCommandJournal(container, { maxEntries: 2, time: () => "12:00:00" });
    journal.append("", "request", { op: "fly_to" });
    journal.append("success", "response", { ok: true });
    journal.append("success", "SSE → browser · revision 3", { op: "objects.update" });

    assert.equal(journal.size, 2);
    assert.deepEqual(
      [...container.children].map((entry) => entry.dataset.logTitle),
      ["SSE → browser · revision 3", "response"]
    );
    assert.match(container.firstElementChild.querySelector("pre").textContent, /objects\.update/);
    assert.equal(container.firstElementChild.querySelector("header span:last-child").textContent, "12:00:00");

    journal.clear();
    assert.equal(journal.size, 0);
  } finally {
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("AI demo pending tracker suppresses only matching local SSE echoes", () => {
  const tracker = createPendingCommandTracker();
  const local = { op: "fly_to", center: { lat: 50, lng: 14 }, zoom: 12 };
  const external = { op: "fly_to", center: { lat: 41, lng: 12 }, zoom: 12 };

  tracker.mark(local, 1);
  tracker.mark(local, 1);
  assert.equal(tracker.has(local), true);
  assert.equal(tracker.has(external), false);
  tracker.mark(local, -1);
  assert.equal(tracker.has(local), true);
  tracker.mark(local, -1);
  assert.equal(tracker.has(local), false);
});
