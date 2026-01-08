import { sniffPackedMLT } from "./layers/mlt.js";
import { decodePackedMVTWasm, mvtGeometryWasmSupported } from "./layers/mvt-wasm.js";
import { registerPackedMvtWasm, registerPackedTileSniffer } from "./layers/mvt.js";

// The low-level packed entry is intentionally separate from the normal map API.
// Keep the same MLT/WASM routing policy as the Advanced root entry.
registerPackedTileSniffer(sniffPackedMLT);
if (mvtGeometryWasmSupported()) registerPackedMvtWasm(decodePackedMVTWasm);

export { decodePackedMVT, decodePackedMVTAsync, packedToGeoJSON } from "./layers/mvt.js";
export type { MVTDecodeOptions, PackedMVTLayer, PackedVectorTile } from "./layers/mvt.js";
