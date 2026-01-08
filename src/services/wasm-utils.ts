/** Internal helpers shared by embedded WASM backends. */
export function decodeBase64Bytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof atob !== "function") throw new Error("base64 decoder unavailable");
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function tryGrowWasmMemory(memory: WebAssembly.Memory, bytes: number): boolean {
  if (bytes <= memory.buffer.byteLength) return true;
  try {
    memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / 65_536));
    return bytes <= memory.buffer.byteLength;
  } catch {
    return false;
  }
}

export function growWasmMemory(memory: WebAssembly.Memory, bytes: number): void {
  const pages = Math.ceil(bytes / 65_536);
  const current = memory.buffer.byteLength / 65_536;
  if (pages > current) memory.grow(pages - current);
}

export function alignWasm4(value: number): number {
  return (value + 3) & ~3;
}

export function alignWasm8(value: number): number {
  return (value + 7) & ~7;
}
