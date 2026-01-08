import type { HeatFieldKernelRequest, HeatFieldKernelResult } from "./heat-field-wasm.js";

export interface HeatFieldWebGpuProfile {
  supported?: boolean; uploadBytes?: number; outputBytes?: number; quantizationScale?: number;
  uploadMs?: number; computeMs?: number; readbackMs?: number; totalMs?: number; error?: string;
}

interface GpuBuffer { destroy(): void; mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; }
interface GpuComputePipeline { getBindGroupLayout(index: number): object; }
interface GpuCommandEncoder {
  beginComputePass(): GpuComputePass;
  clearBuffer(buffer: GpuBuffer, offset?: number, size?: number): void;
  copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, dest: GpuBuffer, destOffset: number, size: number): void;
  finish(): object;
}
interface GpuComputePass {
  setPipeline(pipeline: GpuComputePipeline): void; setBindGroup(index: number, group: object): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void; end(): void;
}
interface GpuDevice {
  createShaderModule(desc: { code: string }): object;
  createComputePipeline(desc: object): GpuComputePipeline;
  createBuffer(desc: { size: number; usage: number }): GpuBuffer;
  createBindGroup(desc: object): object;
  createCommandEncoder(): GpuCommandEncoder;
  queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: BufferSource): void; submit(commands: object[]): void; onSubmittedWorkDone?(): Promise<void>; };
}
interface GpuAdapter { requestDevice(): Promise<GpuDevice>; }
interface Gpu { requestAdapter(options?: object): Promise<GpuAdapter | null>; }

const GPUBufferUsage = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const GPUMapMode = { READ: 0x0001 };
const POINT_WORKGROUP = 256;
const GRID_WORKGROUP = 8;
const MAX_DISPATCH_DIMENSION = 65_535;

/** Point aggregation followed by separable Gaussian KDE; shared semantics with WASM. */
const HEAT_FIELD_WGSL = `
struct Params {
  pointCount: u32, cols: u32, rows: u32, _pad0: u32,
  radiusX: f32, radiusY: f32, quantScale: f32, _pad1: f32,
  westMerc: f32, northMerc: f32, widthMerc: f32, heightMerc: f32,
};
@group(0) @binding(0) var<storage, read> points: array<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> horizontalField: array<f32>;
@group(0) @binding(3) var<storage, read_write> outputField: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

fn addBin(x: i32, y: i32, value: f32) {
  if (value <= 0.0 || x < 0 || y < 0 || x >= i32(params.cols) || y >= i32(params.rows)) { return; }
  let contribution = u32(max(0.0, round(value * params.quantScale)));
  if (contribution > 0u) { atomicAdd(&bins[u32(y) * params.cols + u32(x)], contribution); }
}

@compute @workgroup_size(256, 1, 1)
fn binPoints(@builtin(global_invocation_id) gid: vec3u) {
  let pointIndex = gid.x;
  if (pointIndex >= params.pointCount) { return; }
  let base = pointIndex * 3u;
  let mx = points[base]; let my = points[base + 1u]; let weight = points[base + 2u];
  if (weight <= 0.0) { return; }
  let fx = ((mx - params.westMerc) / params.widthMerc) * f32(params.cols - 1u);
  let fy = ((my - params.northMerc) / params.heightMerc) * f32(params.rows - 1u);
  if (fx < 0.0 || fy < 0.0 || fx > f32(params.cols - 1u) || fy > f32(params.rows - 1u)) { return; }
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let x1 = min(x0 + 1, i32(params.cols) - 1); let y1 = min(y0 + 1, i32(params.rows) - 1);
  let tx = clamp(fx - f32(x0), 0.0, 1.0); let ty = clamp(fy - f32(y0), 0.0, 1.0);
  addBin(x0, y0, weight * (1.0 - tx) * (1.0 - ty));
  addBin(x1, y0, weight * tx * (1.0 - ty));
  addBin(x0, y1, weight * (1.0 - tx) * ty);
  addBin(x1, y1, weight * tx * ty);
}

@compute @workgroup_size(8, 8, 1)
fn blurHorizontal(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= i32(params.cols) || y >= i32(params.rows)) { return; }
  let radius = max(1, i32(ceil(params.radiusX)));
  let from = max(0, x - radius); let to = min(i32(params.cols) - 1, x + radius);
  var value = 0.0;
  for (var sx = from; sx <= to; sx = sx + 1) {
    let d = f32(sx - x) / params.radiusX;
    value += f32(atomicLoad(&bins[u32(y) * params.cols + u32(sx)])) / params.quantScale * exp(-4.0 * d * d);
  }
  horizontalField[u32(y) * params.cols + u32(x)] = value;
}

@compute @workgroup_size(8, 8, 1)
fn blurVertical(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= i32(params.cols) || y >= i32(params.rows)) { return; }
  let radius = max(1, i32(ceil(params.radiusY)));
  let from = max(0, y - radius); let to = min(i32(params.rows) - 1, y + radius);
  var value = 0.0;
  for (var sy = from; sy <= to; sy = sy + 1) {
    let d = f32(sy - y) / params.radiusY;
    value += horizontalField[u32(sy) * params.cols + u32(x)] * exp(-4.0 * d * d);
  }
  outputField[u32(y) * params.cols + u32(x)] = value;
}`;

interface GpuState {
  device: GpuDevice; binPipeline: GpuComputePipeline;
  horizontalPipeline: GpuComputePipeline; verticalPipeline: GpuComputePipeline;
}
let gpuStatePromise: Promise<GpuState | null> | null = null;

export function heatFieldWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as { gpu?: Gpu }).gpu);
}
export async function heatFieldWebGpuSupported(): Promise<boolean> { return (await getGpuState()) != null; }

export async function buildHeatFieldWebGpu(
  request: HeatFieldKernelRequest,
  profile: HeatFieldWebGpuProfile = {}
): Promise<HeatFieldKernelResult | null> {
  const now = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();
  const started = now();
  const state = await getGpuState();
  if (!state) { profile.supported = false; profile.error = "WebGPU is unavailable"; return null; }

  const cols = Math.max(2, Math.floor(request.cols));
  const rows = Math.max(2, Math.floor(request.rows));
  const pointCount = Math.max(0, Math.min(Math.floor(request.pointCount), Math.floor(request.points.length / 3)));
  const cells = cols * rows;
  const radiusX = Math.max(0.51, request.kernelMerc / (request.widthMerc / (cols - 1)));
  const radiusY = Math.max(0.51, request.kernelMerc / (request.heightMerc / (rows - 1)));
  const pointGroups = Math.ceil(pointCount / POINT_WORKGROUP);
  const gridGroupsX = Math.ceil(cols / GRID_WORKGROUP);
  const gridGroupsY = Math.ceil(rows / GRID_WORKGROUP);
  if (!Number.isSafeInteger(cells) || cells <= 0 || pointGroups > MAX_DISPATCH_DIMENSION ||
      gridGroupsX > MAX_DISPATCH_DIMENSION || gridGroupsY > MAX_DISPATCH_DIMENSION) {
    profile.supported = false; profile.error = "WebGPU heat dispatch exceeds safe dimensions"; return null;
  }

  let totalWeight = 0;
  for (let i = 2, end = pointCount * 3; i < end; i += 3) {
    const weight = request.points[i]; if (Number.isFinite(weight) && weight > 0) totalWeight += weight;
  }
  if (!Number.isFinite(totalWeight) || totalWeight >= 0xffff_ffff * 0.9) {
    profile.supported = false; profile.error = "WebGPU heat weights exceed the safe atomic accumulation range"; return null;
  }
  const quantScale = Math.max(1, Math.min(65_536, Math.floor((0xffff_ffff * 0.9) / Math.max(1, totalWeight))));
  const input = new Float32Array(pointCount * 3);
  input.set(request.points.subarray(0, pointCount * 3));
  const inputBytes = Math.max(4, input.byteLength);
  const outputBytes = Math.max(4, cells * 4);
  const { device } = state;
  const inputBuffer = device.createBuffer({ size: align4(inputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const binsBuffer = device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const horizontalBuffer = device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.STORAGE });
  const outputBuffer = device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const paramsBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const readBuffer = device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  try {
    const uploadStarted = now();
    if (input.byteLength) device.queue.writeBuffer(inputBuffer, 0, input);
    const params = new ArrayBuffer(48); const u32 = new Uint32Array(params); const f32 = new Float32Array(params);
    u32[0] = pointCount; u32[1] = cols; u32[2] = rows;
    f32[4] = radiusX; f32[5] = radiusY; f32[6] = quantScale;
    f32[8] = request.westMerc; f32[9] = request.northMerc; f32[10] = request.widthMerc; f32[11] = request.heightMerc;
    device.queue.writeBuffer(paramsBuffer, 0, params);
    profile.uploadMs = now() - uploadStarted;

    const binGroup = device.createBindGroup({ layout: state.binPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: inputBuffer } }, { binding: 1, resource: { buffer: binsBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } }
    ] });
    const horizontalGroup = device.createBindGroup({ layout: state.horizontalPipeline.getBindGroupLayout(0), entries: [
      { binding: 1, resource: { buffer: binsBuffer } }, { binding: 2, resource: { buffer: horizontalBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } }
    ] });
    const verticalGroup = device.createBindGroup({ layout: state.verticalPipeline.getBindGroupLayout(0), entries: [
      { binding: 2, resource: { buffer: horizontalBuffer } }, { binding: 3, resource: { buffer: outputBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } }
    ] });

    const encoder = device.createCommandEncoder(); encoder.clearBuffer(binsBuffer);
    const pass = encoder.beginComputePass();
    if (pointCount > 0) { pass.setPipeline(state.binPipeline); pass.setBindGroup(0, binGroup); pass.dispatchWorkgroups(pointGroups, 1, 1); }
    pass.setPipeline(state.horizontalPipeline); pass.setBindGroup(0, horizontalGroup); pass.dispatchWorkgroups(gridGroupsX, gridGroupsY, 1);
    pass.setPipeline(state.verticalPipeline); pass.setBindGroup(0, verticalGroup); pass.dispatchWorkgroups(gridGroupsX, gridGroupsY, 1);
    pass.end(); encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, outputBytes);
    const computeStarted = now(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone?.();
    profile.computeMs = now() - computeStarted;

    const readbackStarted = now(); await readBuffer.mapAsync(GPUMapMode.READ);
    const grid = new Float32Array(cells); grid.set(new Float32Array(readBuffer.getMappedRange(), 0, cells));
    let peak = 0; let valid = true;
    for (let i = 0; i < cells; i++) {
      const value = grid[i];
      if (!Number.isFinite(value)) valid = false;
      else peak = Math.max(peak, value);
    }
    readBuffer.unmap(); profile.readbackMs = now() - readbackStarted;
    if (!valid || (pointCount > 0 && peak <= 0)) {
      profile.supported = false; profile.error = "WebGPU returned an invalid heat field"; return null;
    }
    profile.supported = true; profile.uploadBytes = input.byteLength; profile.outputBytes = outputBytes;
    profile.quantizationScale = quantScale; profile.totalMs = now() - started;
    return { grid, peak };
  } catch (error) {
    profile.supported = false; profile.error = error instanceof Error ? error.message : String(error); return null;
  } finally {
    inputBuffer.destroy(); binsBuffer.destroy(); horizontalBuffer.destroy(); outputBuffer.destroy(); paramsBuffer.destroy(); readBuffer.destroy();
  }
}

async function getGpuState(): Promise<GpuState | null> {
  if (gpuStatePromise) return gpuStatePromise;
  gpuStatePromise = (async () => {
    try {
      const gpu = typeof navigator !== "undefined" ? (navigator as unknown as { gpu?: Gpu }).gpu : undefined;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }); if (!adapter) return null;
      const device = await adapter.requestDevice(); const module = device.createShaderModule({ code: HEAT_FIELD_WGSL });
      return {
        device,
        binPipeline: device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "binPoints" } }),
        horizontalPipeline: device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "blurHorizontal" } }),
        verticalPipeline: device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "blurVertical" } })
      };
    } catch { gpuStatePromise = null; return null; }
  })();
  return gpuStatePromise;
}

function align4(value: number): number { return (value + 3) & ~3; }
