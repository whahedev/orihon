import { createEl } from "../dom.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { TILE_SIZE, latLng, projectMercator01, type LatLngLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { compileShader, parseCssColor } from "../webgl-utils.js";
import type { ObjectIconAtlas, PackedIcon } from "../services/object-icon-atlas.js";

export interface WebGLSymbolInstance {
  id?: string | number;
  lat: number;
  lng: number;
  icon: string;
  size: number;
  rotation: number;
  opacity: number;
  tint: readonly [number, number, number, number];
  /** Motion: previous mercator */
  prevLat?: number;
  prevLng?: number;
  /** Motion start on the performance.now() clock, in milliseconds. */
  startTimeMs?: number;
  /** Motion duration in milliseconds; zero uses the destination immediately. */
  durationMs?: number;
}

export interface WebGLSymbolLayerOptions extends LayerOptions {
  maxDpr?: number;
  interactive?: boolean;
  hitTolerance?: number;
  fallbackCanvas?: boolean;
}

type Resolved = Required<WebGLSymbolLayerOptions>;

interface GLLocs {
  aCorner: number;
  aMerc: number;
  aPrevMerc: number;
  aUv: number;
  aSize: number;
  aRotation: number;
  aTint: number;
  aMotion: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uAtlas: WebGLUniformLocation | null;
}

/**
 * Instanced icon quads from an ObjectIconAtlas.
 * Supports per-instance size, rotation (degrees), tint, and GPU motion mix.
 */
export class WebGLSymbolLayer extends Layer<Resolved> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  renderer: "webgl" | "canvas" | "none" = "none";
  private program: WebGLProgram | null = null;
  private locs: GLLocs | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private atlas: ObjectIconAtlas | null = null;
  private atlasVersion = -1;
  private instances: WebGLSymbolInstance[] = [];
  private instanceData = new Float32Array(0);
  private count = 0;
  private dirty = true;
  private _interactionUnsub: (() => void) | null = null;
  private fallbackIcon: PackedIcon = {
    name: "",
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    width: 16,
    height: 16,
    anchorX: 0.5,
    anchorY: 0.5,
    pixelRatio: 1
  };

  constructor(options: WebGLSymbolLayerOptions = {}) {
    super({
      pane: "marker",
      attribution: "",
      maxDpr: 2,
      interactive: false,
      hitTolerance: 8,
      fallbackCanvas: true,
      ...options
    });
  }

  setAtlas(atlas: ObjectIconAtlas | null): this {
    this.atlas = atlas;
    this.atlasVersion = -1;
    this.dirty = true;
    return this;
  }

  setInstances(instances: Iterable<WebGLSymbolInstance>): this {
    const next = [...instances];
    for (const instance of next) {
      rejectLegacyUnit(instance, "duration", "durationMs");
      rejectLegacyUnit(instance, "startTime", "startTimeMs");
      if (instance.startTimeMs !== undefined) nonNegativeFinite(instance.startTimeMs, "startTimeMs");
      nonNegativeFinite(instance.durationMs ?? 0, "durationMs");
    }
    this.instances = next;
    this.count = this.instances.length;
    this.dirty = true;
    this.render();
    return this;
  }

  patchInstance(index: number, patch: Partial<WebGLSymbolInstance>): this {
    rejectLegacyUnit(patch, "duration", "durationMs");
    rejectLegacyUnit(patch, "startTime", "startTimeMs");
    if (patch.startTimeMs !== undefined) nonNegativeFinite(patch.startTimeMs, "startTimeMs");
    if (patch.durationMs !== undefined) nonNegativeFinite(patch.durationMs, "durationMs");
    const current = this.instances[index];
    if (!current) return this;
    Object.assign(current, patch);
    this.#writeInstance(index, current);
    this.dirty = true;
    return this;
  }

  patchById(id: string | number, patch: Partial<WebGLSymbolInstance>): boolean {
    for (let i = 0; i < this.instances.length; i++) {
      if (this.instances[i]?.id !== id) continue;
      this.patchInstance(i, patch);
      return true;
    }
    return false;
  }

  getCount(): number {
    return this.count;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-symbol-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.gl = this.canvas.getContext("webgl", {
      antialias: false,
      alpha: true,
      premultipliedAlpha: true
    });
    if (this.gl) {
      this.renderer = "webgl";
      this.#initGl();
    } else if (this.options.fallbackCanvas) {
      this.renderer = "canvas";
    } else {
      this.renderer = "none";
    }
    this.#syncInteraction();
    this.render();
  }

  override onRemove(): void {
    if (this.gl) {
      try {
        if (this.quadBuffer) this.gl.deleteBuffer(this.quadBuffer);
        if (this.instanceBuffer) this.gl.deleteBuffer(this.instanceBuffer);
        if (this.texture) this.gl.deleteTexture(this.texture);
        if (this.program) this.gl.deleteProgram(this.program);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    }
    this.gl = null;
    this.program = null;
    this.locs = null;
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this.texture = null;
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    this.canvas?.remove();
    this.canvas = null;
    this.renderer = "none";
    super.onRemove();
  }

  queryHit(point: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const hit = this.#hitTest(point.x, point.y, options.tolerance);
    return hit == null ? null : {
      layer: this,
      latlng: latLng({ lat: this.instances[hit].lat, lng: this.instances[hit].lng }),
      source: "webgl",
      index: hit,
      id: this.instances[hit].id,
      feature: this.instances[hit]
    };
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const dpr = Math.min(this.options.maxDpr, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.map.size.width * dpr));
    const height = Math.max(1, Math.round(this.map.size.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${this.map.size.width}px`;
    this.canvas.style.height = `${this.map.size.height}px`;
    if (this.renderer === "webgl") this.#renderWebgl(dpr);
    else if (this.renderer === "canvas") this.#renderCanvas(dpr);
  }

  #packInstances(): void {
    const stride = 14;
    if (this.instanceData.length < this.count * stride) {
      this.instanceData = new Float32Array(Math.max(this.count * stride, 14));
    }
    for (let i = 0; i < this.count; i++) this.#writeInstance(i, this.instances[i]);
  }

  #writeInstance(index: number, inst: WebGLSymbolInstance): void {
    const packed = this.atlas?.getPacked(inst.icon) ?? this.fallbackIcon;
    const merc = projectMercator01(inst.lat, inst.lng);
    const prev = projectMercator01(inst.prevLat ?? inst.lat, inst.prevLng ?? inst.lng);
    const o = index * 14;
    const data = this.instanceData;
    data[o] = merc.x;
    data[o + 1] = merc.y;
    data[o + 2] = prev.x;
    data[o + 3] = prev.y;
    data[o + 4] = packed.u0;
    data[o + 5] = packed.v0;
    data[o + 6] = packed.u1;
    data[o + 7] = packed.v1;
    data[o + 8] = Math.max(1, inst.size);
    data[o + 9] = ((Number(inst.rotation) || 0) % 360) * Math.PI / 180;
    data[o + 10] = inst.tint[0];
    data[o + 11] = inst.tint[1];
    data[o + 12] = inst.tint[2];
    data[o + 13] = inst.tint[3] * (Number.isFinite(inst.opacity) ? inst.opacity : 1);
    // motion start/durationMs packed into unused UV corners via extra attrs in shader buffer:
    // We append motion after tint by expanding — keep in parallel arrays for simplicity.
  }

  #initGl(): void {
    const gl = this.gl;
    if (!gl) return;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_corner;
      attribute vec2 a_merc;
      attribute vec2 a_prevMerc;
      attribute vec4 a_uv;
      attribute float a_size;
      attribute float a_rotation;
      attribute vec4 a_tint;
      attribute vec2 a_motion;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_time;
      varying vec2 v_uv;
      varying vec4 v_tint;
      void main() {
        float dur = max(a_motion.y, 0.0001);
        float t = a_motion.y <= 0.0 ? 1.0 : clamp((u_time - a_motion.x) / dur, 0.0, 1.0);
        vec2 merc = mix(a_prevMerc, a_merc, t);
        vec2 pixel = merc * u_scale - u_origin;
        float c = cos(a_rotation);
        float s = sin(a_rotation);
        vec2 local = (a_corner - 0.5) * a_size;
        vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
        vec2 screen = pixel + rotated;
        vec2 clip = ((screen * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
        v_tint = a_tint;
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 v_uv;
      varying vec4 v_tint;
      uniform sampler2D u_atlas;
      void main() {
        vec4 tex = texture2D(u_atlas, v_uv);
        if (tex.a < 0.01) discard;
        gl_FragColor = tex * v_tint;
      }
    `);
    if (!vertex || !fragment) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.program = gl.createProgram();
    if (!this.program) return;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.quadBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();
    this.texture = gl.createTexture();
    this.locs = {
      aCorner: gl.getAttribLocation(this.program, "a_corner"),
      aMerc: gl.getAttribLocation(this.program, "a_merc"),
      aPrevMerc: gl.getAttribLocation(this.program, "a_prevMerc"),
      aUv: gl.getAttribLocation(this.program, "a_uv"),
      aSize: gl.getAttribLocation(this.program, "a_size"),
      aRotation: gl.getAttribLocation(this.program, "a_rotation"),
      aTint: gl.getAttribLocation(this.program, "a_tint"),
      aMotion: gl.getAttribLocation(this.program, "a_motion"),
      uScale: gl.getUniformLocation(this.program, "u_scale"),
      uOrigin: gl.getUniformLocation(this.program, "u_origin"),
      uResolution: gl.getUniformLocation(this.program, "u_resolution"),
      uDpr: gl.getUniformLocation(this.program, "u_dpr"),
      uTime: gl.getUniformLocation(this.program, "u_time"),
      uAtlas: gl.getUniformLocation(this.program, "u_atlas")
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      1, 1
    ]), gl.STATIC_DRAW);
  }

  #ensureTexture(): void {
    const gl = this.gl;
    if (!gl || !this.texture || !this.atlas) return;
    if (this.atlas.version === this.atlasVersion) return;
    const canvas = this.atlas.getCanvas();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (!canvas) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    } else {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as TexImageSource);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasVersion = this.atlas.version;
  }

  #renderWebgl(dpr: number): void {
    const gl = this.gl;
    const locs = this.locs;
    if (!gl || !this.program || !locs || !this.canvas || !this.map) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.count) return;

    this.#ensureTexture();
    // Interleaved: merc(2) prev(2) uv(4) size(1) rot(1) tint(4) motion(2) = 16 floats
    const stride = 16;
    if (this.dirty) {
      const need = this.count * stride;
      if (this.instanceData.length < need) {
        this.instanceData = new Float32Array(Math.max(need, stride));
      }
      const buf = this.instanceData;
      for (let i = 0; i < this.count; i++) {
        const inst = this.instances[i];
        const packed = this.atlas?.getPacked(inst.icon) ?? this.fallbackIcon;
        const merc = projectMercator01(inst.lat, inst.lng);
        const prev = projectMercator01(inst.prevLat ?? inst.lat, inst.prevLng ?? inst.lng);
        const o = i * stride;
        buf[o] = merc.x;
        buf[o + 1] = merc.y;
        buf[o + 2] = prev.x;
        buf[o + 3] = prev.y;
        buf[o + 4] = packed.u0;
        buf[o + 5] = packed.v0;
        buf[o + 6] = packed.u1;
        buf[o + 7] = packed.v1;
        buf[o + 8] = Math.max(1, inst.size);
        buf[o + 9] = ((Number(inst.rotation) || 0) % 360) * Math.PI / 180;
        buf[o + 10] = inst.tint[0];
        buf[o + 11] = inst.tint[1];
        buf[o + 12] = inst.tint[2];
        buf[o + 13] = inst.tint[3] * (Number.isFinite(inst.opacity) ? inst.opacity : 1);
        buf[o + 14] = Number(inst.startTimeMs) || 0;
        buf[o + 15] = Math.max(0, Number(inst.durationMs) || 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, need), gl.DYNAMIC_DRAW);
      this.dirty = false;
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locs.aCorner);
    gl.vertexAttribPointer(locs.aCorner, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

    const ext = gl.getExtension("ANGLE_instanced_arrays");
    if (!ext) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }

    const bind = (loc: number, size: number, offset: number): void => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      ext.vertexAttribDivisorANGLE(loc, 1);
    };
    bind(locs.aMerc, 2, 0);
    bind(locs.aPrevMerc, 2, 2);
    bind(locs.aUv, 4, 4);
    bind(locs.aSize, 1, 8);
    bind(locs.aRotation, 1, 9);
    bind(locs.aTint, 4, 10);
    bind(locs.aMotion, 2, 14);

    const scale = TILE_SIZE * 2 ** this.map.zoom;
    gl.uniform1f(locs.uScale, scale);
    gl.uniform2f(locs.uOrigin, this.map.pixelOrigin.x, this.map.pixelOrigin.y);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uTime, performance.now());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(locs.uAtlas, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, this.count);

    // Reset divisors
    for (const loc of [locs.aMerc, locs.aPrevMerc, locs.aUv, locs.aSize, locs.aRotation, locs.aTint, locs.aMotion]) {
      if (loc >= 0) ext.vertexAttribDivisorANGLE(loc, 0);
    }
  }

  #renderCanvas(dpr: number): void {
    if (!this.canvas || !this.map) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const atlasCanvas = this.atlas?.getCanvas();
    for (const inst of this.instances) {
      const packed = this.atlas?.getPacked(inst.icon);
      const screen = this.map.latLngToContainerPoint({ lat: inst.lat, lng: inst.lng });
      const size = Math.max(1, inst.size) * dpr;
      ctx.save();
      ctx.translate(screen.x * dpr, screen.y * dpr);
      ctx.rotate(((Number(inst.rotation) || 0) % 360) * Math.PI / 180);
      ctx.globalAlpha = (Number.isFinite(inst.opacity) ? inst.opacity : 1) * inst.tint[3];
      if (atlasCanvas && packed) {
        const w = (packed.u1 - packed.u0) * (atlasCanvas as HTMLCanvasElement).width;
        const h = (packed.v1 - packed.v0) * (atlasCanvas as HTMLCanvasElement).height;
        const sx = packed.u0 * (atlasCanvas as HTMLCanvasElement).width;
        const sy = packed.v0 * (atlasCanvas as HTMLCanvasElement).height;
        ctx.drawImage(atlasCanvas as CanvasImageSource, sx, sy, w, h, -size / 2, -size / 2, size, size);
      } else {
        ctx.fillStyle = `rgb(${Math.round(inst.tint[0] * 255)},${Math.round(inst.tint[1] * 255)},${Math.round(inst.tint[2] * 255)})`;
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (!this.canvas || !this.options.interactive) return;
    const onClick = (event: MouseEvent): void => {
      const rect = this.canvas!.getBoundingClientRect();
      const hit = this.#hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit == null) return;
      this.emit("click", {
        originalEvent: event,
        index: hit,
        latlng: { lat: this.instances[hit].lat, lng: this.instances[hit].lng },
        data: this.instances[hit]
      });
    };
    this.canvas.addEventListener("click", onClick);
    this._interactionUnsub = () => this.canvas?.removeEventListener("click", onClick);
  }

  #hitTest(x: number, y: number, tolerance = this.options.hitTolerance): number | null {
    if (!this.map) return null;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      const screen = this.map.latLngToContainerPoint({ lat: inst.lat, lng: inst.lng });
      const radius = Math.max(1, inst.size) / 2 + Math.max(0, tolerance);
      const dist = (screen.x - x) ** 2 + (screen.y - y) ** 2;
      if (dist <= radius * radius && dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    return best < 0 ? null : best;
  }
}

export function webglSymbolLayer(options?: WebGLSymbolLayerOptions): WebGLSymbolLayer {
  return new WebGLSymbolLayer(options);
}
