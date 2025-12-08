import { registerGpuTileFactory } from "./layers/tile-layer.js";
import { WebGPUTileLayer } from "./layers/webgpu-tile-layer.js";

registerGpuTileFactory((template, options) => new WebGPUTileLayer(template, options));

export { WebGPUTileLayer, webgpuTileLayer, type WebGPUTileLayerOptions, type WebGPUTileLayerStats } from "./layers/webgpu-tile-layer.js";
