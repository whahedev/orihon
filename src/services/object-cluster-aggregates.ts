import type { ObjectId } from "./object-types.js";

export interface AggregateObject {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ClusterAggregateOperation = "count" | "sum" | "min" | "max";

export interface ClusterPropertyDefinition {
  operation: ClusterAggregateOperation;
  value?: (object: AggregateObject) => number;
  filter?: (object: AggregateObject) => boolean;
}

export type ClusterPropertiesConfig = Record<string, ClusterPropertyDefinition>;

export interface ClusterAggregateValues {
  count: number;
  properties: Record<string, number>;
  containsSelected: boolean;
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function emptyClusterAggregates(config: ClusterPropertiesConfig = {}): ClusterAggregateValues {
  const properties: Record<string, number> = {};
  for (const [key, def] of Object.entries(config)) {
    if (def.operation === "min") properties[key] = Number.POSITIVE_INFINITY;
    else if (def.operation === "max") properties[key] = Number.NEGATIVE_INFINITY;
    else properties[key] = 0;
  }
  return { count: 0, properties, containsSelected: false };
}

export function accumulateClusterAggregates(
  target: ClusterAggregateValues,
  object: AggregateObject,
  id: ObjectId,
  selectedId: ObjectId | null,
  config: ClusterPropertiesConfig
): void {
  target.count += 1;
  if (selectedId != null && id === selectedId) target.containsSelected = true;
  for (const [key, def] of Object.entries(config)) {
    if (def.filter && !def.filter(object)) continue;
    if (def.operation === "count") {
      target.properties[key] = (target.properties[key] ?? 0) + 1;
      continue;
    }
    const value = numeric(def.value?.(object));
    if (def.operation === "sum") {
      target.properties[key] = (target.properties[key] ?? 0) + value;
    } else if (def.operation === "min") {
      target.properties[key] = Math.min(target.properties[key] ?? Number.POSITIVE_INFINITY, value);
    } else if (def.operation === "max") {
      target.properties[key] = Math.max(target.properties[key] ?? Number.NEGATIVE_INFINITY, value);
    }
  }
}

export function finalizeClusterAggregates(
  values: ClusterAggregateValues,
  config: ClusterPropertiesConfig
): ClusterAggregateValues {
  for (const [key, def] of Object.entries(config)) {
    if (def.operation === "min" && !Number.isFinite(values.properties[key])) values.properties[key] = 0;
    if (def.operation === "max" && !Number.isFinite(values.properties[key])) values.properties[key] = 0;
  }
  return values;
}

export function computeClusterAggregates(
  ids: ObjectId[],
  objects: Map<ObjectId, AggregateObject>,
  selectedId: ObjectId | null,
  config: ClusterPropertiesConfig
): ClusterAggregateValues {
  const values = emptyClusterAggregates(config);
  for (const id of ids) {
    const object = objects.get(id);
    if (!object) continue;
    accumulateClusterAggregates(values, object, id, selectedId, config);
  }
  return finalizeClusterAggregates(values, config);
}
