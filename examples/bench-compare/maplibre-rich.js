/** MapLibre custom rich points: GPU buffer + category colors + grid hit-test.
 * Avoids GeoJSON FeatureCollection (blank/OOM at ~1M).
 * MapLibre GL JS v5+ (WebGL2 + CustomRenderMethodInput).
 */
const PALETTE = {
  alpha: [15 / 255, 118 / 255, 110 / 255, 0.88],
  beta: [37 / 255, 99 / 255, 235 / 255, 0.88],
  gamma: [202 / 255, 138 / 255, 4 / 255, 0.88],
  alert: [220 / 255, 38 / 255, 38 / 255, 0.92],
  selected: [124 / 255, 58 / 255, 237 / 255, 0.95],
  hover: [245 / 255, 158 / 255, 11 / 255, 0.95]
};

function rgbaFor(object, selectedId, hoveredId) {
  const id = object.id;
  if (selectedId != null && id === selectedId) return PALETTE.selected;
  if (hoveredId != null && id === hoveredId) return PALETTE.hover;
  if (object.properties?.alert) return PALETTE.alert;
  const cat = object.properties?.category || "alpha";
  if (cat === "beta") return PALETTE.beta;
  if (cat === "gamma") return PALETTE.gamma;
  return PALETTE.alpha;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || "shader compile failed");
  }
  return shader;
}

function projectionMatrix(args) {
  if (!args) return null;
  // MapLibre v5 custom-layer example uses defaultProjectionData.mainMatrix with MercatorCoordinate.
  // modelViewProjectionMatrix is a different space — using it first projects points off-screen.
  if (args.defaultProjectionData?.mainMatrix) return args.defaultProjectionData.mainMatrix;
  if (args.modelViewProjectionMatrix) return args.modelViewProjectionMatrix;
  if (typeof args.length === "number") return args;
  return null;
}

/**
 * @param {maplibregl.Map} map
 * @param {Array<{id:number, coordinates:[number,number], properties?:object}>} objects
 * @param {{ id?: string, pointSize?: number }} [options]
 */
export function createMapLibreRichPoints(map, objects, options = {}) {
  const layerId = options.id || "bench-rich-points";
  const pointSize = options.pointSize || 4.5;
  const n = objects.length;

  const positions = new Float32Array(n * 2);
  const colors = new Float32Array(n * 4);
  const visible = new Uint8Array(n);
  visible.fill(1);

  let selectedId = null;
  let hoveredId = null;
  let filterMode = "all";
  let drawCount = n;
  let drawPositions = positions;
  let drawColors = colors;
  /** Remap draw index → object index when filtered. */
  let drawIndex = null;

  let gl = null;
  let program = null;
  let posBuffer = null;
  let colorBuffer = null;
  let vao = null;
  let aPos = -1;
  let aColor = -1;
  let uMatrix = null;
  let uSize = null;
  let isWebGL2 = false;
  let buffersDirty = true;

  // Coarse screen-space grid rebuilt lazily for hit-tests (avoids O(N) on mousemove at 1M).
  let grid = null;
  let gridZoom = NaN;
  let gridCenterKey = "";
  const GRID = 48;

  function writePoint(i) {
    const object = objects[i];
    const [lat, lng] = object.coordinates;
    const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat });
    positions[i * 2] = merc.x;
    positions[i * 2 + 1] = merc.y;
    const rgba = rgbaFor(object, selectedId, hoveredId);
    const o = i * 4;
    colors[o] = rgba[0];
    colors[o + 1] = rgba[1];
    colors[o + 2] = rgba[2];
    colors[o + 3] = rgba[3];
  }

  for (let i = 0; i < n; i++) writePoint(i);

  function matchesFilter(object) {
    if (filterMode === "all") return true;
    if (filterMode === "alert") return Boolean(object.properties?.alert);
    return object.properties?.category === filterMode;
  }

  function invalidateGrid() {
    grid = null;
  }

  function rebuildDrawList() {
    invalidateGrid();
    if (filterMode === "all") {
      drawCount = n;
      drawPositions = positions;
      drawColors = colors;
      drawIndex = null;
      for (let i = 0; i < n; i++) visible[i] = 1;
      buffersDirty = true;
      return;
    }
    let w = 0;
    // First pass: count, then allocate exact size (avoids 1M scratch on every filter).
    for (let i = 0; i < n; i++) {
      const ok = matchesFilter(objects[i]);
      visible[i] = ok ? 1 : 0;
      if (ok) w += 1;
    }
    const pos = new Float32Array(w * 2);
    const col = new Float32Array(w * 4);
    const idx = new Int32Array(w);
    let o = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      pos[o * 2] = positions[i * 2];
      pos[o * 2 + 1] = positions[i * 2 + 1];
      col[o * 4] = colors[i * 4];
      col[o * 4 + 1] = colors[i * 4 + 1];
      col[o * 4 + 2] = colors[i * 4 + 2];
      col[o * 4 + 3] = colors[i * 4 + 3];
      idx[o] = i;
      o += 1;
    }
    drawCount = w;
    drawPositions = pos;
    drawColors = col;
    drawIndex = idx;
    buffersDirty = true;
  }

  function upload() {
    if (!gl || !posBuffer || !colorBuffer || !buffersDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawColors, gl.DYNAMIC_DRAW);
    buffersDirty = false;
  }

  function bindAttribs(ctx) {
    if (vao && isWebGL2) {
      ctx.bindVertexArray(vao);
      return;
    }
    ctx.bindBuffer(ctx.ARRAY_BUFFER, posBuffer);
    ctx.enableVertexAttribArray(aPos);
    ctx.vertexAttribPointer(aPos, 2, ctx.FLOAT, false, 0, 0);
    ctx.bindBuffer(ctx.ARRAY_BUFFER, colorBuffer);
    ctx.enableVertexAttribArray(aColor);
    ctx.vertexAttribPointer(aColor, 4, ctx.FLOAT, false, 0, 0);
  }

  function recolorTouched(ids) {
    for (const id of ids) {
      if (id == null || id < 0 || id >= n) continue;
      writePoint(id);
    }
    if (filterMode === "all") {
      buffersDirty = true;
    } else {
      rebuildDrawList();
    }
  }

  function ensureGrid() {
    const zoom = map.getZoom();
    const c = map.getCenter();
    const key = `${c.lng.toFixed(3)},${c.lat.toFixed(3)}`;
    if (grid && gridZoom === zoom && gridCenterKey === key) return grid;
    const cells = new Array(GRID * GRID);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    const canvas = map.getCanvas();
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const total = drawCount;
    // Cap grid build cost: stride when huge.
    const stride = total > 200_000 ? Math.ceil(total / 200_000) : 1;
    for (let d = 0; d < total; d += stride) {
      const i = drawIndex ? drawIndex[d] : d;
      const object = objects[i];
      if (!object?.coordinates) continue;
      const p = map.project([object.coordinates[1], object.coordinates[0]]);
      if (p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
      const gx = Math.min(GRID - 1, Math.max(0, ((p.x / w) * GRID) | 0));
      const gy = Math.min(GRID - 1, Math.max(0, ((p.y / h) * GRID) | 0));
      cells[gy * GRID + gx].push(i);
    }
    grid = { cells, w, h };
    gridZoom = zoom;
    gridCenterKey = key;
    return grid;
  }

  const layer = {
    id: layerId,
    type: "custom",
    renderingMode: "2d",
    onAdd(_map, context) {
      gl = context;
      isWebGL2 =
        typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext;
      const vs = isWebGL2
        ? `#version 300 es
          in vec2 a_pos;
          in vec4 a_color;
          uniform mat4 u_matrix;
          uniform float u_size;
          out vec4 v_color;
          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            gl_PointSize = u_size;
            v_color = a_color;
          }`
        : `
          attribute vec2 a_pos;
          attribute vec4 a_color;
          uniform mat4 u_matrix;
          uniform float u_size;
          varying vec4 v_color;
          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            gl_PointSize = u_size;
            v_color = a_color;
          }`;
      const fs = isWebGL2
        ? `#version 300 es
          precision mediump float;
          in vec4 v_color;
          out vec4 fragColor;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            if (dot(c, c) > 0.25) discard;
            fragColor = v_color;
          }`
        : `
          precision mediump float;
          varying vec4 v_color;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            if (dot(c, c) > 0.25) discard;
            gl_FragColor = v_color;
          }`;
      const vertex = compile(gl, gl.VERTEX_SHADER, vs);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, fs);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "program link failed");
      }
      aPos = gl.getAttribLocation(program, "a_pos");
      aColor = gl.getAttribLocation(program, "a_color");
      uMatrix = gl.getUniformLocation(program, "u_matrix");
      uSize = gl.getUniformLocation(program, "u_size");
      posBuffer = gl.createBuffer();
      colorBuffer = gl.createBuffer();
      if (isWebGL2 && gl.createVertexArray) {
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.enableVertexAttribArray(aColor);
        gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
      }
      buffersDirty = true;
      upload();
      if (vao && isWebGL2) {
        // Re-bind attribs after first upload so VAO records buffer contents binding.
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.enableVertexAttribArray(aColor);
        gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
      }
    },
    render(context, args) {
      if (!program || !posBuffer || !colorBuffer || !drawCount) return;
      const matrix = projectionMatrix(args);
      if (!matrix) return;
      upload();
      const ctx = context;
      ctx.useProgram(program);
      ctx.uniformMatrix4fv(uMatrix, false, matrix);
      const zoom = map.getZoom?.() ?? 5;
      const sizeBoost = zoom < 5 ? 1.6 : zoom < 7 ? 1.25 : 1;
      let size = pointSize * sizeBoost * (window.devicePixelRatio || 1);
      // Respect driver point-size clamp (ANGLE often caps ~1..255; never submit 0).
      try {
        const range = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE);
        if (range && range.length >= 2) {
          size = Math.min(range[1], Math.max(range[0] || 1, size));
        }
      } catch {
        /* */
      }
      ctx.uniform1f(uSize, size);
      bindAttribs(ctx);
      ctx.disable(ctx.DEPTH_TEST);
      ctx.disable(ctx.STENCIL_TEST);
      ctx.depthMask(false);
      ctx.enable(ctx.BLEND);
      ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);
      // Some ANGLE/D3D drivers drop a single 1M POINTS draw — chunk it.
      const CHUNK = 262144;
      if (drawCount <= CHUNK) {
        ctx.drawArrays(ctx.POINTS, 0, drawCount);
      } else {
        for (let start = 0; start < drawCount; start += CHUNK) {
          ctx.drawArrays(ctx.POINTS, start, Math.min(CHUNK, drawCount - start));
        }
      }
      if (vao && isWebGL2) ctx.bindVertexArray(null);
    },
    onRemove(_map, context) {
      if (vao && context.deleteVertexArray) context.deleteVertexArray(vao);
      if (posBuffer) context.deleteBuffer(posBuffer);
      if (colorBuffer) context.deleteBuffer(colorBuffer);
      if (program) context.deleteProgram(program);
      posBuffer = colorBuffer = program = vao = gl = null;
    }
  };

  map.addLayer(layer);

  return {
    get drawn() {
      return drawCount;
    },
    get filterMode() {
      return filterMode;
    },
    get selectedId() {
      return selectedId;
    },
    get hoveredId() {
      return hoveredId;
    },
    setFilter(mode) {
      filterMode = mode || "all";
      rebuildDrawList();
      map.triggerRepaint();
      return drawCount;
    },
    applyLive(updates) {
      for (const object of updates) {
        const id = object.id;
        if (id == null || id < 0 || id >= n) continue;
        objects[id] = object;
        writePoint(id);
      }
      invalidateGrid();
      if (filterMode === "all") buffersDirty = true;
      else rebuildDrawList();
      map.triggerRepaint();
    },
    setSelected(id) {
      const prev = selectedId;
      selectedId = id;
      recolorTouched([prev, id]);
      map.triggerRepaint();
    },
    setHovered(id) {
      const prev = hoveredId;
      hoveredId = id;
      recolorTouched([prev, id]);
      map.triggerRepaint();
    },
    /** Screen-space nearest among currently visible points (grid-accelerated). */
    hitTest(clientX, clientY, tolerance = 12) {
      const rect = map.getContainer().getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (drawCount <= 0) return null;

      // Small sets: linear is fine and exact.
      if (drawCount <= 8_000) {
        let best = -1;
        let bestDist = tolerance;
        for (let d = 0; d < drawCount; d++) {
          const i = drawIndex ? drawIndex[d] : d;
          const object = objects[i];
          if (!object?.coordinates) continue;
          const p = map.project([object.coordinates[1], object.coordinates[0]]);
          const dist = Math.hypot(p.x - x, p.y - y);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
        return best < 0 ? null : best;
      }

      const g = ensureGrid();
      const gx = Math.min(GRID - 1, Math.max(0, ((x / g.w) * GRID) | 0));
      const gy = Math.min(GRID - 1, Math.max(0, ((y / g.h) * GRID) | 0));
      let best = -1;
      let bestDist = tolerance;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox;
          const cy = gy + oy;
          if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) continue;
          const bucket = g.cells[cy * GRID + cx];
          for (let b = 0; b < bucket.length; b++) {
            const i = bucket[b];
            const object = objects[i];
            if (!object?.coordinates) continue;
            const p = map.project([object.coordinates[1], object.coordinates[0]]);
            const dist = Math.hypot(p.x - x, p.y - y);
            if (dist < bestDist) {
              bestDist = dist;
              best = i;
            }
          }
        }
      }
      return best < 0 ? null : best;
    },
    remove() {
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      } catch {
        /* map already removed */
      }
    }
  };
}
