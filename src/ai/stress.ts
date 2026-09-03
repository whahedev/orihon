import type {
  AIEngineCommand,
  AIObjectFeature,
  AIPointSpec,
  AIPosition,
  AIVisualizationStressIntent,
  AIVisualizationStressUpdateIntent
} from "./types.js";

const LATITUDE_METERS = 111_320;

function sample(seed: number, index: number, salt: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  value ^= value >>> 15;
  return (value >>> 0) / 0x1_0000_0000;
}

function offset(center: AIPosition, eastKm: number, northKm: number): AIPosition {
  const latitude = center.lat + (northKm * 1000) / LATITUDE_METERS;
  const longitudeScale = Math.max(0.1, Math.cos(center.lat * Math.PI / 180));
  return {
    lat: latitude,
    lng: center.lng + (eastKm * 1000) / (LATITUDE_METERS * longitudeScale)
  };
}

function vehicle(
  collection: string,
  center: AIPosition,
  spreadKm: number,
  seed: number,
  index: number,
  tick: number
): AIObjectFeature {
  const radius = Math.sqrt(sample(seed, index, 0x51f15e)) * spreadKm;
  const baseAngle = sample(seed, index, 0xa2c79d) * Math.PI * 2;
  const angularSpeed = 0.018 + sample(seed, index, 0x7b1d31) * 0.035;
  const angle = baseAngle + tick * angularSpeed;
  const wobble = Math.sin(tick * 0.17 + index * 0.013) * spreadKm * 0.025;
  const position = offset(center, Math.cos(angle) * (radius + wobble), Math.sin(angle) * (radius + wobble));
  const speed = 18 + Math.round(sample(seed, index, 0xd4e123) * 62);
  const category = (["alpha", "beta", "gamma", "alert"] as const)[index % 4];
  const id = `${collection}-${String(index + 1).padStart(5, "0")}`;
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [position.lng, position.lat] },
    properties: {
      title: `Объект ${index + 1}`,
      popup: `Скорость ${speed} км/ч · пакет ${tick}`,
      category,
      speed,
      heading: Math.round((angle * 180 / Math.PI + 90) % 360)
    }
  };
}

function routePoints(intent: AIVisualizationStressIntent): AIPointSpec[] {
  const spreadKm = intent.spreadKm ?? 18;
  const seed = intent.seed ?? 42;
  return Array.from({ length: intent.routeStops }, (_, index) => {
    const progress = index / Math.max(1, intent.routeStops - 1);
    const angle = progress * Math.PI * 4.5 + sample(seed, index, 0x19fd43) * 0.2;
    const radius = spreadKm * (0.15 + progress * 0.75);
    const position = offset(intent.center, Math.cos(angle) * radius, Math.sin(angle) * radius * 0.65);
    return {
      id: `load-stop-${String(index + 1).padStart(3, "0")}`,
      position,
      title: `Контрольная точка ${index + 1}`,
      popup: "Остановка нагрузочного маршрута"
    };
  });
}

export function visualizationStressCommands(intent: AIVisualizationStressIntent): AIEngineCommand[] {
  const seed = intent.seed ?? 42;
  const spreadKm = intent.spreadKm ?? 18;
  const stopsCollection = `${intent.collection}-route-stops`;
  const points = routePoints(intent);
  const objects = Array.from({ length: intent.objectCount }, (_, index) => (
    vehicle(intent.collection, intent.center, spreadKm, seed, index, 0)
  ));
  return [{
    op: "points.replace",
    collection: stopsCollection,
    points,
    clearMap: true,
    defaults: { category: "alert" },
    viewport: { mode: "fit", padding: 42, animation: "none" }
  }, {
    op: "route.plan",
    routeId: intent.routeId,
    collection: stopsCollection,
    optimize: "shortest",
    reactive: false
  }, {
    op: "objects.replace",
    collection: intent.collection,
    objects
  }];
}

export function visualizationStressUpdateCommands(intent: AIVisualizationStressUpdateIntent): AIEngineCommand[] {
  const seed = intent.seed ?? 42;
  const spreadKm = intent.spreadKm ?? 18;
  return [{
    op: "objects.update",
    collection: intent.collection,
    objects: Array.from({ length: intent.updateCount }, (_, index) => (
      vehicle(intent.collection, intent.center, spreadKm, seed, index, intent.tick)
    ))
  }];
}
