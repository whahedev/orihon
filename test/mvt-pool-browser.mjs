import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind MVT pool browser server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);

  const result = await page.evaluate(async () => {
    const { decodePackedMVTAsync } = await import("/dist/layers/mvt.js");

    // Smallest valid MVT carrying one point, with the tile's own index as the feature id so a
    // response that came back from the wrong worker would be visible.
    const varint = (value) => {
      const out = [];
      let n = value;
      while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
      out.push(n);
      return out;
    };
    const tag = (field, wire) => varint((field << 3) | wire);
    const bytes = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];
    const int = (field, value) => [...tag(field, 0), ...varint(value)];
    const str = (text) => [...text].map((c) => c.charCodeAt(0));

    const tileFor = (id) => new Uint8Array(bytes(3, [
      ...int(15, 2),
      ...bytes(1, str("places")),
      ...bytes(2, [
        ...int(1, id),
        ...int(3, 1),
        ...bytes(4, [9, 4096, 4096].flatMap((g) => varint(g)))
      ]),
      ...int(5, 4096)
    ]));

    // More at once than the pool can ever hold, so some requests must queue behind others.
    const count = 24;
    const decoded = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        decodePackedMVTAsync(tileFor(i + 1), { x: i, y: 0, z: 4 }, { layer: "places" })
      )
    );

    // Ownership contract: transferInput detaches what it was given, and only that.
    const kept = tileFor(1).slice().buffer;
    await decodePackedMVTAsync(kept, { x: 0, y: 0, z: 4 }, { layer: "places" });

    const given = tileFor(1).slice().buffer;
    await decodePackedMVTAsync(given, { x: 0, y: 0, z: 4 }, { layer: "places", transferInput: true });

    // A view over part of a larger buffer cannot be transferred, so it must fall back to a copy.
    const backing = new ArrayBuffer(tileFor(1).byteLength + 8);
    const partial = new Uint8Array(backing, 4, tileFor(1).byteLength);
    partial.set(tileFor(1));
    const fromPartial = await decodePackedMVTAsync(partial, { x: 0, y: 0, z: 4 }, { layer: "places", transferInput: true });

    return {
      count: decoded.length,
      tilesInOrder: decoded.every((packed, i) => packed.x === i && packed.z === 4),
      everyTileHasItsLayer: decoded.every((packed) => packed.layers?.[0]?.name === "places"),
      ids: decoded.map((packed) => packed.layers[0].ids[0]),
      keptAlive: kept.byteLength > 0,
      givenDetached: given.byteLength === 0,
      partialSurvived: backing.byteLength > 0,
      partialDecoded: fromPartial.layers?.[0]?.name === "places"
    };
  });

  assert.equal(result.count, 24, "every concurrent decode resolved");
  assert.ok(result.tilesInOrder, "each promise resolved with the tile it was given");
  assert.ok(result.everyTileHasItsLayer, "every decode returned its layer");
  // A response routed to the wrong pending entry would show up as a duplicated or shifted id.
  assert.deepEqual(result.ids, Array.from({ length: 24 }, (_, i) => i + 1), "ids match their tiles");

  assert.ok(result.keptAlive, "a buffer decoded without transferInput is left usable");
  assert.ok(result.givenDetached, "transferInput hands the buffer over instead of copying it");
  assert.ok(result.partialSurvived, "a partial view falls back to a copy rather than detaching its backing buffer");
  assert.ok(result.partialDecoded, "and still decodes");

  console.log("mvt pool browser checks passed · 24 concurrent decodes, ids intact, ownership held");
} finally {
  await browser.close();
  server.close();
}
