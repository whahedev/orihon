/**
 * Advanced rendering and data APIs. Importing this entry explicitly activates
 * the optional GPU and packed-vector-tile integrations.
 */
export * from "./index.js";

import { registerGpuTileFactory } from "./layers/tile-layer.js";
import { GPUTileLayer } from "./layers/gpu-tile-layer.js";
import { registerGeoJSONWebGLBatch } from "./layers/geojson.js";
import { WebGLPathBatch } from "./layers/webgl-path-batch.js";
import { sniffPackedMLT } from "./layers/mlt.js";
import { decodePackedMVTWasm, mvtGeometryWasmSupported } from "./layers/mvt-wasm.js";
import { registerPackedMvtWasm, registerPackedTileSniffer } from "./layers/mvt.js";

registerGpuTileFactory((template, options) => new GPUTileLayer(template, {
  ...options,
  backend: options?.renderer === "webgl" || options?.renderer === "webgpu" ? options.renderer : "auto"
}));
registerGeoJSONWebGLBatch((options) => new WebGLPathBatch(options));
registerPackedTileSniffer(sniffPackedMLT);
if (mvtGeometryWasmSupported()) registerPackedMvtWasm(decodePackedMVTWasm);
