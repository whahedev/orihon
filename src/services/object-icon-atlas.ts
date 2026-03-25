import type { ObjectId } from "./object-types.js";

export type ManagedIconSource =
  | HTMLImageElement
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas;

export interface ManagedIconOptions {
  pixelRatio?: number;
  /** Anchor in 0..1 relative to sprite size. Default [0.5, 0.5]. */
  anchor?: readonly [number, number];
}

export interface PackedIcon {
  name: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  pixelRatio: number;
}

function sourceSize(source: ManagedIconSource): { width: number; height: number } {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    return { width: source.width, height: source.height };
  }
  const anySource = source as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const width = Number(anySource.naturalWidth ?? anySource.width ?? 0);
  const height = Number(anySource.naturalHeight ?? anySource.height ?? 0);
  return { width, height };
}

function canDrawImage(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Packs registered icons into a single canvas/texture atlas.
 * Rebuilds only on register/remove/clear — never on object moves.
 */
export class ObjectIconAtlas {
  private readonly sources = new Map<string, { source: ManagedIconSource; options: ManagedIconOptions }>();
  private packed = new Map<string, PackedIcon>();
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private textureVersion = 0;
  private dirty = true;

  get version(): number {
    return this.textureVersion;
  }

  get size(): number {
    return this.sources.size;
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  register(name: string, source: ManagedIconSource, options: ManagedIconOptions = {}): this {
    if (!name) throw new TypeError("ObjectManager: icon name is required");
    this.sources.set(String(name), { source, options: { ...options } });
    this.dirty = true;
    return this;
  }

  remove(name: string): this {
    if (!this.sources.delete(String(name))) return this;
    this.dirty = true;
    return this;
  }

  clear(): this {
    if (!this.sources.size) return this;
    this.sources.clear();
    this.packed.clear();
    this.canvas = null;
    this.dirty = true;
    this.textureVersion++;
    return this;
  }

  getPacked(name: string): PackedIcon | null {
    this.#ensurePacked();
    return this.packed.get(String(name)) ?? null;
  }

  getCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
    this.#ensurePacked();
    return this.canvas;
  }

  names(): string[] {
    return [...this.sources.keys()];
  }

  #ensurePacked(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.packed.clear();
    if (!this.sources.size || !canDrawImage()) {
      this.canvas = null;
      this.textureVersion++;
      return;
    }

    const entries: Array<{
      name: string;
      source: ManagedIconSource;
      options: ManagedIconOptions;
      width: number;
      height: number;
    }> = [];
    for (const [name, entry] of this.sources) {
      const size = sourceSize(entry.source);
      if (size.width <= 0 || size.height <= 0) continue;
      entries.push({ name, ...entry, width: size.width, height: size.height });
    }
    if (!entries.length) {
      this.canvas = null;
      this.textureVersion++;
      return;
    }

    // Simple shelf packer (row-based).
    const padding = 2;
    const maxRowWidth = 2048;
    let x = padding;
    let y = padding;
    let rowHeight = 0;
    let atlasW = padding;
    let atlasH = padding;
    const placements: Array<{ name: string; x: number; y: number; width: number; height: number; options: ManagedIconOptions }> = [];

    for (const entry of entries) {
      if (x + entry.width + padding > maxRowWidth) {
        x = padding;
        y += rowHeight + padding;
        rowHeight = 0;
      }
      placements.push({
        name: entry.name,
        x,
        y,
        width: entry.width,
        height: entry.height,
        options: entry.options
      });
      rowHeight = Math.max(rowHeight, entry.height);
      x += entry.width + padding;
      atlasW = Math.max(atlasW, x);
      atlasH = Math.max(atlasH, y + entry.height + padding);
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(atlasW));
    canvas.height = Math.max(1, Math.ceil(atlasH));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.canvas = null;
      this.textureVersion++;
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const place of placements) {
      const source = this.sources.get(place.name)!.source;
      try {
        ctx.drawImage(source as CanvasImageSource, place.x, place.y);
      } catch {
        continue;
      }
      const anchor = place.options.anchor ?? [0.5, 0.5];
      this.packed.set(place.name, {
        name: place.name,
        u0: place.x / canvas.width,
        v0: place.y / canvas.height,
        u1: (place.x + place.width) / canvas.width,
        v1: (place.y + place.height) / canvas.height,
        width: place.width,
        height: place.height,
        anchorX: Number(anchor[0]) || 0.5,
        anchorY: Number(anchor[1]) || 0.5,
        pixelRatio: Math.max(0.1, Number(place.options.pixelRatio) || 1)
      });
    }

    this.canvas = canvas;
    this.textureVersion++;
  }
}
