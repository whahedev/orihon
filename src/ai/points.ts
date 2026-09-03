import type {
  AIObjectFeature,
  AIPointDefaults,
  AIPointSpec,
  AIPointVisual,
  AIPointVisualDefaults,
  AIPointsReplaceCommand
} from "./types.js";

function mergeVisual(
  defaults: AIPointVisualDefaults | undefined,
  point: AIPointVisual | undefined
): AIPointVisual | undefined {
  if (!defaults && !point) return undefined;
  if (!defaults) return point;
  if (!point) {
    // Defaults alone are only useful when they already form a valid visual (label and/or image.url).
    if (defaults.label !== undefined) {
      return {
        ...(defaults.image && typeof defaults.image.url === "string"
          ? { image: { url: defaults.image.url, ...defaults.image } as AIPointVisual["image"] }
          : {}),
        label: defaults.label,
        ...(defaults.size !== undefined ? { size: defaults.size } : {}),
        ...(defaults.collisionMode !== undefined ? { collisionMode: defaults.collisionMode } : {})
      };
    }
    return undefined;
  }
  const imageDefaults = defaults.image;
  const image = point.image
    ? {
        ...(imageDefaults ?? {}),
        ...point.image
      }
    : imageDefaults && typeof imageDefaults.url === "string"
      ? { ...imageDefaults, url: imageDefaults.url }
      : undefined;
  const result: AIPointVisual = {
    ...(image ? { image } : {}),
    label: point.label !== undefined ? point.label : defaults.label,
    size: point.size !== undefined ? point.size : defaults.size,
    collisionMode: point.collisionMode !== undefined ? point.collisionMode : defaults.collisionMode
  };
  if (!result.image && result.label === undefined) return undefined;
  return result;
}

function applyDefaults(point: AIPointSpec, defaults?: AIPointDefaults): AIPointSpec {
  if (!defaults) return point;
  const visual = mergeVisual(defaults.visual, point.visual);
  return {
    ...point,
    ...(point.category === undefined && defaults.category !== undefined ? { category: defaults.category } : {}),
    ...(visual ? { visual } : {})
  };
}

/** Convert the compact point command into canonical GeoJSON objects. */
export function pointCommandFeatures(command: AIPointsReplaceCommand): AIObjectFeature[] {
  return command.points.map((raw) => {
    const point = applyDefaults(raw, command.defaults);
    const properties: Record<string, unknown> = {};
    if (point.title !== undefined) properties.title = point.title;
    if (point.popup !== undefined) properties.popup = point.popup;
    if (point.visual !== undefined) properties.visual = point.visual;
    if (point.category !== undefined) properties.category = point.category;
    return {
      type: "Feature",
      id: point.id,
      geometry: { type: "Point", coordinates: [point.position.lng, point.position.lat] },
      properties
    };
  });
}
