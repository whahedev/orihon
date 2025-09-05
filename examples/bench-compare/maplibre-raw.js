/** Minimal MapLibre custom point layer backed by a mercator Float32 buffer.
 * Compatible with MapLibre GL JS v5+ (WebGL2 + CustomRenderMethodInput).
 */
export function createMapLibreRawPoints(map, points, options = {}) {
  const id = options.id || "bench-raw-points";
  const color = options.color || [0.176, 0.831, 0.753, 0.78];
  const pointSize = options.pointSize || 2.5;

  const positions = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    const [lat, lng] = points[i];
    const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat });
    positions[i * 2] = merc.x;
    positions[i * 2 + 1] = merc.y;
  }

  let gl = null;
  let program = null;
  let buffer = null;
  let aPos = -1;
  let uMatrix = null;
  let uSize = null;
  let uColor = null;
  let count = points.length;
  let isWebGL2 = false;

  function compile(ctx, type, source) {
    const shader = ctx.createShader(type);
    ctx.shaderSource(shader, source);
    ctx.compileShader(shader);
    if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
      throw new Error(ctx.getShaderInfoLog(shader) || "shader compile failed");
    }
    return shader;
  }

  function projectionMatrix(args) {
    if (!args) return null;
    if (args.defaultProjectionData?.mainMatrix) return args.defaultProjectionData.mainMatrix;
    if (args.modelViewProjectionMatrix) return args.modelViewProjectionMatrix;
    // MapLibre ≤4 passed a raw Float32Array / mat4 as the second argument.
    if (typeof args.length === "number") return args;
    return null;
  }

  const layer = {
    id,
    type: "custom",
    renderingMode: "2d",
    onAdd(_mapInstance, context) {
      gl = context;
      isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext;

      const vs = isWebGL2
        ? `#version 300 es
          in vec2 a_pos;
          uniform mat4 u_matrix;
          uniform float u_size;
          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            gl_PointSize = u_size;
          }`
        : `
          attribute vec2 a_pos;
          uniform mat4 u_matrix;
          uniform float u_size;
          void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            gl_PointSize = u_size;
          }`;

      const fs = isWebGL2
        ? `#version 300 es
          precision mediump float;
          uniform vec4 u_color;
          out vec4 fragColor;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            if (dot(c, c) > 0.25) discard;
            fragColor = u_color;
          }`
        : `
          precision mediump float;
          uniform vec4 u_color;
          void main() {
            vec2 c = gl_PointCoord - vec2(0.5);
            if (dot(c, c) > 0.25) discard;
            gl_FragColor = u_color;
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
      uMatrix = gl.getUniformLocation(program, "u_matrix");
      uSize = gl.getUniformLocation(program, "u_size");
      uColor = gl.getUniformLocation(program, "u_color");
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    },
    render(context, args) {
      if (!program || !buffer) return;
      const ctx = context;
      const matrix = projectionMatrix(args);
      if (!matrix) return;
      ctx.useProgram(program);
      ctx.uniformMatrix4fv(uMatrix, false, matrix);
      ctx.uniform1f(uSize, pointSize * (window.devicePixelRatio || 1));
      ctx.uniform4fv(uColor, color);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
      ctx.enableVertexAttribArray(aPos);
      ctx.vertexAttribPointer(aPos, 2, ctx.FLOAT, false, 0, 0);
      ctx.enable(ctx.BLEND);
      ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);
      ctx.drawArrays(ctx.POINTS, 0, count);
    },
    onRemove(_mapInstance, context) {
      if (buffer) context.deleteBuffer(buffer);
      if (program) context.deleteProgram(program);
      buffer = null;
      program = null;
      gl = null;
    }
  };

  map.addLayer(layer);

  return {
    updatePoints(nextPoints) {
      count = nextPoints.length;
      if (positions.length < count * 2) {
        count = positions.length / 2;
      }
      for (let i = 0; i < count; i++) {
        const [lat, lng] = nextPoints[i];
        const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat });
        positions[i * 2] = merc.x;
        positions[i * 2 + 1] = merc.y;
      }
      if (gl && buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions.subarray(0, count * 2));
      }
      map.triggerRepaint();
    },
    remove() {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  };
}
