import { registerGpuTileFactory } from "./layers/tile-layer.js";
import { GPUTileLayer } from "./layers/gpu-tile-layer.js";

registerGpuTileFactory((template, options) => new GPUTileLayer(template, {
  ...options,
  backend: options?.renderer === "webgl" || options?.renderer === "webgpu" ? options.renderer : "auto"
}));

export { GPUTileLayer, type GPUTileBackend, type GPUTileLayerOptions, type GPUTileLayerStats } from "./layers/gpu-tile-layer.js";
export {
  buildHeatFieldWebGpu,
  heatFieldWebGpuAvailable,
  heatFieldWebGpuSupported,
  type HeatFieldWebGpuProfile
} from "./services/heat-field-webgpu.js";
