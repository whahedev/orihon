import { createEl, listen } from "../dom.js";
import { MAX_LAT, TILE_SIZE, latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions } from "../overlays/div-overlay.js";

export type WebGLPointInput = LatLngLike | { coordinates?: LatLngLike; latlng?: LatLngLike; lat?: number; lng?: number };

export interface WebGLPointLayerOptions extends LayerOptions {
  pointSize?: number;
  color?: string;
  opacity?: number;
  maxDpr?: number;
  fallbackCanvas?: boolean;
  rotation?: number;
  pitch?: number;
  interactive?: boolean;
  hitTolerance?: number;
  /** When true, canvas fallback still CPU-culls. WebGL always transforms on GPU. */
  cull?: boolean;
}

type ResolvedWebGLPointLayerOptions = Required<WebGLPointLayerOptions>;

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface GLLocations {
  aMerc: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  uRotate: WebGLUniformLocation | null;
  uPitch: WebGLUniformLocation | null;
}

export interface WebGLPointLayerStats {
  points: number;
  rendered: number;
  renderer: "webgl" | "canvas" | "none";
  bufferBytes: number;
}

export class WebGLPointLayer extends Layer<ResolvedWebGLPointLayerOptions> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  program: WebGLProgram | null = null;
  buffer: WebGLBuffer | null = null;
  /** Packed lat/lng pairs for hit-testing and canvas fallback. */
  points: Float32Array = new Float32Array();
  /** Packed normalized Web-Mercator x/y (0..1 world). Uploaded once to GPU. */
  mercator: Float32Array = new Float32Array();
  pointData: WebGLPointInput[] = [];
  renderer: "webgl" | "canvas" | "none" = "none";
  readonly color: RGB;
  private _interactionUnsub: (() => void) | null = null;
  private _lastRendered = 0;
  private _glLocations: GLLocations | null = null;
  private _bufferDirty = true;
  private _scratch: Float32Array = new Float32Array(0);
  private _latlngBuf = new Float32Array(0);
  private _mercBuf = new Float32Array(0);
  private _gpuMercBytes = 0;

  constructor(points: Iterable<WebGLPointInput> = [], options: WebGLPointLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      pointSize: 5,
      color: "#e11d48",
      opacity: 0.82,
      maxDpr: 2,
      fallbackCanvas: true,
      rotation: 0,
      pitch: 0,
      interactive: false,
      hitTolerance: 5,
      cull: true,
      ...options
    });
    this.color = parseColor(this.options.color);
    this.setData(points);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-point-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.gl = this.canvas.getContext("webgl", {
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      premultipliedAlpha: true
    });
    if (this.gl) {
      this.renderer = "webgl";
      this.#initWebGL();
    } else if (this.options.fallbackCanvas && this.canvas.getContext("2d")) {
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
        if (this.buffer) this.gl.deleteBuffer(this.buffer);
        if (this.program) this.gl.deleteProgram(this.program);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* context may already be lost */
      }
    }
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this._glLocations = null;
    this._gpuMercBytes = 0;
    this.renderer = "none";
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.points = new Float32Array();
    this.mercator = new Float32Array();
    this.pointData = [];
    this._latlngBuf = new Float32Array(0);
    this._mercBuf = new Float32Array(0);
    this._scratch = new Float32Array(0);
    super.onRemove();
  }

  setData(points: Iterable<WebGLPointInput>): this {
    const keepData = this.options.interactive;

    if (Array.isArray(points)) {
      const need = points.length * 2;
      if (this._latlngBuf.length < need) {
        this._latlngBuf = new Float32Array(need);
        this._mercBuf = new Float32Array(need);
      }
      const latlng = this._latlngBuf;
      const merc = this._mercBuf;
      const data: WebGLPointInput[] = keepData ? new Array(points.length) : [];
      let write = 0;
      let kept = 0;
      for (let index = 0; index < points.length; index++) {
        const item = points[index];
        const next = normalizePoint(item);
        if (!next) continue;
        const m = latLngToMercator(next.lat, next.lng);
        latlng[write] = next.lat;
        latlng[write + 1] = next.lng;
        merc[write] = m.x;
        merc[write + 1] = m.y;
        write += 2;
        if (keepData) data[kept++] = item;
      }
      this.points = latlng.subarray(0, write);
      this.mercator = merc.subarray(0, write);
      this.pointData = keepData ? data.slice(0, kept) : [];
    } else {
      const latlngValues: number[] = [];
      const mercValues: number[] = [];
      this.pointData = [];
      for (const item of points) {
        const next = normalizePoint(item);
        if (!next) continue;
        const m = latLngToMercator(next.lat, next.lng);
        latlngValues.push(next.lat, next.lng);
        mercValues.push(m.x, m.y);
        if (keepData) this.pointData.push(item);
      }
      this._latlngBuf = new Float32Array(latlngValues);
      this._mercBuf = new Float32Array(mercValues);
      this.points = this._latlngBuf;
      this.mercator = this._mercBuf;
    }

    this._bufferDirty = true;
    this.render();
    return this;
  }

  addData(points: Iterable<WebGLPointInput>): this {
    const existing: WebGLPointInput[] = [];
    for (let i = 0; i < this.points.length; i += 2) {
      existing.push([this.points[i], this.points[i + 1]]);
    }
    for (const item of points) existing.push(item);
    return this.setData(existing);
  }

  clear(): this {
    this.points = new Float32Array();
    this.mercator = new Float32Array();
    this.pointData = [];
    this._gpuMercBytes = 0;
    this._bufferDirty = true;
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  setInteractive(enabled: boolean): this {
    this.options.interactive = Boolean(enabled);
    if (this.canvas) this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.#syncInteraction();
    return this;
  }

  setViewTransform(options: { rotation?: number; pitch?: number }): this {
    if (typeof options.rotation === "number") this.options.rotation = options.rotation;
    if (typeof options.pitch === "number") this.options.pitch = Math.max(0, Math.min(60, options.pitch));
    this.render();
    return this;
  }

  getStats(): WebGLPointLayerStats {
    return {
      points: this.points.length / 2,
      rendered: this._lastRendered,
      renderer: this.renderer,
      bufferBytes: this.points.byteLength + this.mercator.byteLength
    };
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const dpr = Math.min(this.options.maxDpr, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.map.size.width * dpr));
    const height = Math.max(1, Math.round(this.map.size.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.left = "0px";
    this.canvas.style.top = "0px";
    this.canvas.style.width = `${this.map.size.width}px`;
    this.canvas.style.height = `${this.map.size.height}px`;
    if (this.renderer === "webgl") this.#renderWebGL(dpr);
    else if (this.renderer === "canvas") this.#renderCanvas(dpr);
  }

  #initWebGL(): void {
    const gl = this.gl;
    if (!gl) return;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_merc;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_pointSize;
      uniform vec2 u_center;
      uniform float u_rotate;
      uniform float u_pitch;
      void main() {
        vec2 pixel = a_merc * u_scale - u_origin;
        if (u_rotate != 0.0 || u_pitch != 1.0) {
          vec2 d = pixel - u_center;
          d.y *= u_pitch;
          float c = cos(u_rotate);
          float s = sin(u_rotate);
          pixel = u_center + vec2(d.x * c - d.y * s, d.x * s + d.y * c);
        }
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = u_pointSize;
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        vec2 offset = gl_PointCoord - vec2(0.5);
        if (dot(offset, offset) > 0.25) discard;
        gl_FragColor = u_color;
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
    this.buffer = gl.createBuffer();
    this._glLocations = {
      aMerc: gl.getAttribLocation(this.program, "a_merc"),
      uScale: gl.getUniformLocation(this.program, "u_scale"),
      uOrigin: gl.getUniformLocation(this.program, "u_origin"),
      uResolution: gl.getUniformLocation(this.program, "u_resolution"),
      uDpr: gl.getUniformLocation(this.program, "u_dpr"),
      uPointSize: gl.getUniformLocation(this.program, "u_pointSize"),
      uColor: gl.getUniformLocation(this.program, "u_color"),
      uCenter: gl.getUniformLocation(this.program, "u_center"),
      uRotate: gl.getUniformLocation(this.program, "u_rotate"),
      uPitch: gl.getUniformLocation(this.program, "u_pitch")
    };
    this._bufferDirty = true;
  }

  #uploadMercatorIfNeeded(): void {
    const gl = this.gl;
    if (!gl || !this.buffer || !this._bufferDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const bytes = this.mercator.byteLength;
    // Reuse GPU storage on live updates — repeated bufferData(STATIC) leaks VRAM on some drivers.
    if (bytes > 0 && bytes === this._gpuMercBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mercator);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.mercator, gl.DYNAMIC_DRAW);
      this._gpuMercBytes = bytes;
    }
    this._bufferDirty = false;
  }

  /** Fast screen projection from precomputed mercator — used by canvas cull + hit-test. */
  #mercatorToScreen(mx: number, my: number, scale: number, originX: number, originY: number): { x: number; y: number } {
    let x = mx * scale - originX;
    let y = my * scale - originY;
    if (this.options.rotation !== 0 || this.options.pitch !== 0) {
      const transformed = this.#transformPoint(x, y);
      x = transformed.x;
      y = transformed.y;
    }
    return { x, y };
  }

  #projectVisibleCanvas(dpr: number): Float32Array {
    if (!this.map || !this.mercator.length) {
      this._lastRendered = 0;
      return new Float32Array();
    }

    const map = this.map;
    const scale = TILE_SIZE * 2 ** map.zoom;
    const originX = map.pixelOrigin.x;
    const originY = map.pixelOrigin.y;
    const width = map.size.width;
    const height = map.size.height;
    const padding = this.options.pointSize + 2;
    const source = this.mercator;
    const needed = source.length;
    if (this._scratch.length < needed) this._scratch = new Float32Array(needed);
    const projected = this._scratch;
    let write = 0;
    const cull = this.options.cull !== false;

    for (let index = 0; index < source.length; index += 2) {
      const point = this.#mercatorToScreen(source[index], source[index + 1], scale, originX, originY);
      if (cull && (point.x < -padding || point.y < -padding || point.x > width + padding || point.y > height + padding)) {
        continue;
      }
      projected[write++] = point.x * dpr;
      projected[write++] = point.y * dpr;
    }

    this._lastRendered = write / 2;
    return projected.subarray(0, write);
  }

  #transformPoint(x: number, y: number): { x: number; y: number } {
    if (!this.map) return { x, y };
    const rotation = (this.options.rotation * Math.PI) / 180;
    const pitchScale = Math.cos((this.options.pitch * Math.PI) / 180);
    if (!rotation && this.options.pitch === 0) return { x, y };
    const cx = this.map.size.width / 2;
    const cy = this.map.size.height / 2;
    const dx = x - cx;
    const dy = (y - cy) * pitchScale;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos
    };
  }

  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (!this.canvas || !this.options.interactive) return;
    this._interactionUnsub = listen(this.canvas, "click", (event) => {
      const hit = this.#hitTest(event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      this.emit("click", {
        originalEvent: event,
        latlng: hit.latlng,
        containerPoint: hit.containerPoint,
        index: hit.index,
        data: this.pointData[hit.index]
      });
    });
  }

  #hitTest(clientX: number, clientY: number): {
    index: number;
    latlng: LatLngLike;
    containerPoint: { x: number; y: number };
  } | null {
    if (!this.map || !this.mercator.length) return null;
    const rect = this.map.container.getBoundingClientRect();
    const targetX = clientX - rect.left;
    const targetY = clientY - rect.top;
    const tolerance = Math.max(0, this.options.hitTolerance) + this.options.pointSize / 2;
    const maxDistance = tolerance * tolerance;
    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const originX = this.map.pixelOrigin.x;
    const originY = this.map.pixelOrigin.y;
    let nearest = -1;
    let nearestDistance = maxDistance;
    let nearestPoint = { x: 0, y: 0 };
    const merc = this.mercator;
    for (let index = 0; index < merc.length; index += 2) {
      const point = this.#mercatorToScreen(merc[index], merc[index + 1], scale, originX, originY);
      const distance = (point.x - targetX) ** 2 + (point.y - targetY) ** 2;
      if (distance > nearestDistance) continue;
      nearest = index / 2;
      nearestDistance = distance;
      nearestPoint = point;
    }
    if (nearest < 0) return null;
    return {
      index: nearest,
      latlng: [this.points[nearest * 2], this.points[nearest * 2 + 1]],
      containerPoint: nearestPoint
    };
  }

  #renderWebGL(dpr: number): void {
    const gl = this.gl;
    const locs = this._glLocations;
    if (!gl || !this.program || !this.buffer || !this.canvas || !locs || !this.map) return;

    const count = this.mercator.length / 2;
    this._lastRendered = count;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return;

    this.#uploadMercatorIfNeeded();

    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const rotation = (this.options.rotation * Math.PI) / 180;
    const pitch = Math.cos((this.options.pitch * Math.PI) / 180);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(locs.aMerc);
    gl.vertexAttribPointer(locs.aMerc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(locs.uScale, scale);
    gl.uniform2f(locs.uOrigin, this.map.pixelOrigin.x, this.map.pixelOrigin.y);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uPointSize, this.options.pointSize * dpr);
    gl.uniform4f(
      locs.uColor,
      this.color.r / 255,
      this.color.g / 255,
      this.color.b / 255,
      this.options.opacity
    );
    gl.uniform2f(locs.uCenter, this.map.size.width / 2, this.map.size.height / 2);
    gl.uniform1f(locs.uRotate, rotation);
    gl.uniform1f(locs.uPitch, pitch);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  #renderCanvas(dpr: number): void {
    if (!this.canvas) return;
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const data = this.#projectVisibleCanvas(dpr);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.globalAlpha = this.options.opacity;
    context.fillStyle = `rgb(${this.color.r},${this.color.g},${this.color.b})`;
    const radius = Math.max(1, (this.options.pointSize * dpr) / 2);
    for (let index = 0; index < data.length; index += 2) {
      context.beginPath();
      context.arc(data[index], data[index + 1], radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }
}

export function webglPointLayer(points?: Iterable<WebGLPointInput>, options?: WebGLPointLayerOptions): WebGLPointLayer {
  return new WebGLPointLayer(points, options);
}

function latLngToMercator(lat: number, lng: number): { x: number; y: number } {
  let clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  let wrappedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

function normalizePoint(value: WebGLPointInput): { lat: number; lng: number } | null {
  const source = Array.isArray(value) || value instanceof Object && "lat" in value && "lng" in value
    ? value as LatLngLike
    : (value as { coordinates?: LatLngLike; latlng?: LatLngLike }).coordinates ?? (value as { latlng?: LatLngLike }).latlng;
  if (!source) return null;
  const point = latLng(source);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return point;
}

function parseColor(value: string): RGB {
  const text = String(value || "").trim();
  const hex = text.startsWith("#") ? text.slice(1) : "";
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0] + hex[0], 16),
      g: Number.parseInt(hex[1] + hex[1], 16),
      b: Number.parseInt(hex[2] + hex[2], 16)
    };
  }
  if (hex.length === 6) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }
  return { r: 225, g: 29, b: 72 };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
