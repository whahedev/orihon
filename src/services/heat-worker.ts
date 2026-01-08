import type { LatLngBoundsLike } from "../geo.js";
import type { PackedHeatBounds, PackedHeatPoints } from "./heat-field.js";
import {
  buildPackedHeat,
  type HeatOptions,
  type HeatResult
} from "./heat.js";

interface HeatWorkerDataMessage {
  type: "data";
  revision: number;
  data: Float32Array;
  count: number;
  bounds?: PackedHeatBounds;
}

interface HeatWorkerBuildMessage {
  type: "build";
  id: number;
  revision: number;
  bounds: LatLngBoundsLike;
  options: HeatOptions;
}

type HeatWorkerMessage = HeatWorkerDataMessage | HeatWorkerBuildMessage;

let packed: PackedHeatPoints = { data: new Float32Array(0), count: 0 };
let revision = -1;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<HeatWorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event): void => {
  const message = event.data;
  if (message.type === "data") {
    packed = { data: message.data, count: message.count, bounds: message.bounds };
    revision = message.revision;
    return;
  }
  void build(message);
};
workerScope.postMessage({ type: "ready" });

async function build(message: HeatWorkerBuildMessage): Promise<void> {
  if (message.revision !== revision) {
    workerScope.postMessage({ type: "error", id: message.id, error: "stale heat dataset" });
    return;
  }
  try {
    const result = await buildPackedHeat(packed, message.bounds, message.options);
    const transfer: Transferable[] = [];
    if (result) transfer.push(result.field.grid.buffer);
    workerScope.postMessage({ type: "result", id: message.id, result }, transfer);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export {};
