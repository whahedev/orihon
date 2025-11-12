import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.resolve(root, "test", "fixtures");

const value = message([fieldBytes(1, stringBytes("Fixture"))]);
const feature = message([
  fieldVarint(1, 1),
  fieldBytes(2, packed([0, 0])),
  fieldVarint(3, 1),
  fieldBytes(4, packed([9, 4096, 4096]))
]);
const layer = message([
  fieldVarint(15, 2),
  fieldBytes(1, stringBytes("places")),
  fieldBytes(2, feature),
  fieldBytes(3, stringBytes("name")),
  fieldBytes(4, value),
  fieldVarint(5, 4096)
]);
const tile = message([fieldBytes(3, layer)]);
const directory = Uint8Array.from([1, 0, 1, tile.length, 0]);
const tileOffset = 127 + directory.length;
const archive = new Uint8Array(tileOffset + tile.length);
archive.set(new TextEncoder().encode("PMTiles"), 0);
archive[7] = 3;
const header = new DataView(archive.buffer);
header.setBigUint64(8, 127n, true);
header.setBigUint64(16, BigInt(directory.length), true);
header.setBigUint64(24, BigInt(tileOffset), true);
header.setBigUint64(32, 0n, true);
header.setBigUint64(40, BigInt(tileOffset), true);
header.setBigUint64(48, 0n, true);
header.setBigUint64(56, BigInt(tileOffset), true);
header.setBigUint64(64, BigInt(tile.length), true);
header.setBigUint64(72, 1n, true);
header.setBigUint64(80, 1n, true);
header.setBigUint64(88, 1n, true);
archive[96] = 1;
archive[97] = 1;
archive[98] = 1;
archive[99] = 1;
archive[100] = 0;
archive[101] = 0;
header.setInt32(102, -1_800_000_000, true);
header.setInt32(106, -850_511_287, true);
header.setInt32(110, 1_800_000_000, true);
header.setInt32(114, 850_511_287, true);
archive[118] = 0;
header.setInt32(119, 0, true);
header.setInt32(123, 0, true);
archive.set(directory, 127);
archive.set(tile, tileOffset);

await mkdir(fixtures, { recursive: true });
await writeFile(path.resolve(fixtures, "tiny.pmtiles"), archive);
console.log(`wrote test/fixtures/tiny.pmtiles (${archive.length} bytes)`);

function message(parts) {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function fieldVarint(field, number) {
  return new Uint8Array([...varint((field << 3) | 0), ...varint(number)]);
}

function fieldBytes(field, bytes) {
  return new Uint8Array([...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]);
}

function packed(values) {
  return new Uint8Array(values.flatMap((number) => [...varint(number)]));
}

function stringBytes(text) {
  return new TextEncoder().encode(text);
}

function varint(number) {
  const result = [];
  let next = number;
  while (next > 0x7f) {
    result.push((next & 0x7f) | 0x80);
    next = Math.floor(next / 128);
  }
  result.push(next);
  return result;
}
