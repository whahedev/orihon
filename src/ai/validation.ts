import { AIError } from "./errors.js";
import type {
  AIBasemapSpec,
  AICommand,
  AILayerDescription,
  AILayerSpec,
  AIPathStyle,
  AIPosition,
  AISceneSpec,
  AITextContent
} from "./types.js";

type JSONObject = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LAYER_TYPES = new Set(["marker", "polyline", "polygon", "geojson", "raster"]);

function fail(code: ConstructorParameters<typeof AIError>[0], path: string, message: string, received?: unknown): never {
  throw new AIError(code, path, message, received);
}

function object(value: unknown, path: string): JSONObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TYPE", path, "Expected an object", value);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("NOT_JSON", path, "Expected a plain JSON object", value);
  }
  return value as JSONObject;
}

function keys(value: JSONObject, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) fail("UNKNOWN_PROPERTY", `${path}.${key}`, `Unknown property "${key}"`, value[key]);
  }
}

function required(value: JSONObject, key: string, path: string): unknown {
  if (!(key in value)) fail("REQUIRED_PROPERTY", `${path}.${key}`, `Required property "${key}" is missing`);
  return value[key];
}

function string(value: unknown, path: string, { nonEmpty = false }: { nonEmpty?: boolean } = {}): string {
  if (typeof value !== "string") fail("INVALID_TYPE", path, "Expected a string", value);
  if (nonEmpty && value.trim().length === 0) fail("INVALID_VALUE", path, "String must not be empty", value);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("INVALID_TYPE", path, "Expected a boolean", value);
  return value;
}

function number(value: unknown, path: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("INVALID_TYPE", path, "Expected a finite number", value);
  if (options.integer && !Number.isInteger(value)) fail("INVALID_VALUE", path, "Expected an integer", value);
  if (options.min !== undefined && value < options.min) fail("INVALID_VALUE", path, `Value must be at least ${options.min}`, value);
  if (options.max !== undefined && value > options.max) fail("INVALID_VALUE", path, `Value must be at most ${options.max}`, value);
  return value;
}

function optional<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): T | undefined {
  return value === undefined ? undefined : read(value, path);
}

function id(value: unknown, path: string): string {
  const result = string(value, path, { nonEmpty: true });
  if (!ID_PATTERN.test(result)) {
    fail("INVALID_VALUE", path, "ID must be 1-128 characters and contain only letters, numbers, '.', '_', ':' or '-'", value);
  }
  return result;
}

function position(value: unknown, path: string): AIPosition {
  const source = object(value, path);
  keys(source, ["lat", "lng"], path);
  const lat = number(required(source, "lat", path), `${path}.lat`);
  const lng = number(required(source, "lng", path), `${path}.lng`);
  if (lat < -90 || lat > 90) fail("INVALID_COORDINATE", `${path}.lat`, "Latitude must be between -90 and 90", lat);
  if (lng < -180 || lng > 180) fail("INVALID_COORDINATE", `${path}.lng`, "Longitude must be between -180 and 180", lng);
  return { lat, lng };
}

function positions(value: unknown, path: string, minimum: number): AIPosition[] {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path, "Expected an array of {lat,lng} objects", value);
  if (value.length < minimum) fail("INVALID_VALUE", path, `Expected at least ${minimum} coordinates`, value);
  return value.map((entry, index) => position(entry, `${path}[${index}]`));
}

function textContent(value: unknown, path: string): AITextContent {
  const source = object(value, path);
  keys(source, ["text"], path);
  return { text: string(required(source, "text", path), `${path}.text`) };
}

function pathStyle(value: unknown, path: string): AIPathStyle {
  const source = object(value, path);
  const allowed = ["stroke", "strokeWidth", "strokeOpacity", "fill", "fillOpacity", "lineCap", "lineJoin", "dashArray", "dashOffset", "geodesic", "arrow", "arrowSize", "interactive"];
  keys(source, allowed, path);
  const result: AIPathStyle = {};
  if (source.stroke !== undefined) result.stroke = string(source.stroke, `${path}.stroke`, { nonEmpty: true });
  if (source.strokeWidth !== undefined) result.strokeWidth = number(source.strokeWidth, `${path}.strokeWidth`, { min: 0 });
  if (source.strokeOpacity !== undefined) result.strokeOpacity = number(source.strokeOpacity, `${path}.strokeOpacity`, { min: 0, max: 1 });
  if (source.fill !== undefined) result.fill = string(source.fill, `${path}.fill`, { nonEmpty: true });
  if (source.fillOpacity !== undefined) result.fillOpacity = number(source.fillOpacity, `${path}.fillOpacity`, { min: 0, max: 1 });
  if (source.lineCap !== undefined) {
    const next = string(source.lineCap, `${path}.lineCap`);
    if (!["butt", "round", "square"].includes(next)) fail("INVALID_VALUE", `${path}.lineCap`, "Expected butt, round or square", next);
    result.lineCap = next as AIPathStyle["lineCap"];
  }
  if (source.lineJoin !== undefined) {
    const next = string(source.lineJoin, `${path}.lineJoin`);
    if (!["bevel", "round", "miter"].includes(next)) fail("INVALID_VALUE", `${path}.lineJoin`, "Expected bevel, round or miter", next);
    result.lineJoin = next as AIPathStyle["lineJoin"];
  }
  if (source.dashArray !== undefined) {
    if (source.dashArray === null || typeof source.dashArray === "string") result.dashArray = source.dashArray;
    else if (Array.isArray(source.dashArray)) result.dashArray = source.dashArray.map((entry, index) => number(entry, `${path}.dashArray[${index}]`, { min: 0 }));
    else fail("INVALID_TYPE", `${path}.dashArray`, "Expected a string, number array or null", source.dashArray);
  }
  if (source.dashOffset !== undefined) result.dashOffset = number(source.dashOffset, `${path}.dashOffset`);
  if (source.geodesic !== undefined) result.geodesic = boolean(source.geodesic, `${path}.geodesic`);
  if (source.arrow !== undefined) {
    if (typeof source.arrow === "boolean") result.arrow = source.arrow;
    else {
      const next = string(source.arrow, `${path}.arrow`);
      if (!["end", "start", "both"].includes(next)) fail("INVALID_VALUE", `${path}.arrow`, "Expected a boolean, end, start or both", next);
      result.arrow = next as AIPathStyle["arrow"];
    }
  }
  if (source.arrowSize !== undefined) result.arrowSize = number(source.arrowSize, `${path}.arrowSize`, { min: 0 });
  if (source.interactive !== undefined) result.interactive = boolean(source.interactive, `${path}.interactive`);
  return result;
}

function json(value: unknown, path: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NOT_JSON", path, "JSON numbers must be finite", value);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("NOT_JSON", path, "Circular values are not JSON", value);
    seen.add(value);
    const result = value.map((entry, index) => json(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    const source = object(value, path);
    if (seen.has(source)) fail("NOT_JSON", path, "Circular values are not JSON", value);
    seen.add(source);
    const result: JSONObject = {};
    for (const [key, entry] of Object.entries(source)) {
      if (entry === undefined) fail("NOT_JSON", `${path}.${key}`, "undefined is not valid JSON", entry);
      result[key] = json(entry, `${path}.${key}`, seen);
    }
    seen.delete(source);
    return result;
  }
  fail("NOT_JSON", path, "Expected a JSON value", value);
}

function layer(value: unknown, path: string, requireId: boolean): AILayerSpec | AILayerDescription {
  const source = object(value, path);
  const layerType = string(required(source, "type", path), `${path}.type`);
  if (!LAYER_TYPES.has(layerType)) fail("INVALID_VALUE", `${path}.type`, "Expected marker, polyline, polygon, geojson or raster", layerType);
  const common = ["type", "attribution", "popup", "tooltip", ...(requireId ? ["id"] : [])];
  const result: JSONObject = { type: layerType };
  if (requireId) result.id = id(required(source, "id", path), `${path}.id`);
  if (source.attribution !== undefined) result.attribution = string(source.attribution, `${path}.attribution`);
  if (source.popup !== undefined) result.popup = textContent(source.popup, `${path}.popup`);
  if (source.tooltip !== undefined) result.tooltip = textContent(source.tooltip, `${path}.tooltip`);

  if (layerType === "marker") {
    keys(source, [...common, "position", "title", "appearance", "opacity", "zIndexOffset", "interactive", "rotation"], path);
    result.position = position(required(source, "position", path), `${path}.position`);
    if (source.title !== undefined) result.title = string(source.title, `${path}.title`);
    if (source.appearance !== undefined) {
      const appearance = object(source.appearance, `${path}.appearance`);
      keys(appearance, ["shape", "color", "strokeColor", "size", "strokeWidth"], `${path}.appearance`);
      const next: JSONObject = {};
      if (appearance.shape !== undefined) {
        const shape = string(appearance.shape, `${path}.appearance.shape`);
        if (!["pin", "circle", "square", "dot", "diamond", "triangle"].includes(shape)) fail("INVALID_VALUE", `${path}.appearance.shape`, "Unknown marker shape", shape);
        next.shape = shape;
      }
      if (appearance.color !== undefined) next.color = string(appearance.color, `${path}.appearance.color`, { nonEmpty: true });
      if (appearance.strokeColor !== undefined) next.strokeColor = string(appearance.strokeColor, `${path}.appearance.strokeColor`, { nonEmpty: true });
      if (appearance.size !== undefined) next.size = number(appearance.size, `${path}.appearance.size`, { min: 1 });
      if (appearance.strokeWidth !== undefined) next.strokeWidth = number(appearance.strokeWidth, `${path}.appearance.strokeWidth`, { min: 0 });
      result.appearance = next;
    }
    if (source.opacity !== undefined) result.opacity = number(source.opacity, `${path}.opacity`, { min: 0, max: 1 });
    if (source.zIndexOffset !== undefined) result.zIndexOffset = number(source.zIndexOffset, `${path}.zIndexOffset`);
    if (source.interactive !== undefined) result.interactive = boolean(source.interactive, `${path}.interactive`);
    if (source.rotation !== undefined) result.rotation = number(source.rotation, `${path}.rotation`);
  } else if (layerType === "polyline") {
    keys(source, [...common, "coordinates", "style"], path);
    result.coordinates = positions(required(source, "coordinates", path), `${path}.coordinates`, 2);
    if (source.style !== undefined) result.style = pathStyle(source.style, `${path}.style`);
  } else if (layerType === "polygon") {
    keys(source, [...common, "rings", "style"], path);
    const rings = required(source, "rings", path);
    if (!Array.isArray(rings) || rings.length === 0) fail("INVALID_TYPE", `${path}.rings`, "Expected a non-empty coordinate ring or array of rings", rings);
    result.rings = Array.isArray(rings[0])
      ? rings.map((ring, index) => positions(ring, `${path}.rings[${index}]`, 3))
      : positions(rings, `${path}.rings`, 3);
    if (source.style !== undefined) result.style = pathStyle(source.style, `${path}.style`);
  } else if (layerType === "geojson") {
    keys(source, [...common, "data", "style", "renderer", "maxFeatures"], path);
    result.data = json(required(source, "data", path), `${path}.data`);
    const data = result.data as JSONObject;
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") {
      fail("INVALID_VALUE", `${path}.data`, "GeoJSON data must be an object with a type property", result.data);
    }
    if (source.style !== undefined) result.style = pathStyle(source.style, `${path}.style`);
    if (source.renderer !== undefined) {
      const renderer = string(source.renderer, `${path}.renderer`);
      if (!["svg", "canvas", "auto"].includes(renderer)) fail("INVALID_VALUE", `${path}.renderer`, "Expected svg, canvas or auto", renderer);
      result.renderer = renderer;
    }
    if (source.maxFeatures !== undefined) result.maxFeatures = number(source.maxFeatures, `${path}.maxFeatures`, { min: 1, integer: true });
  } else {
    keys(source, [...common, "url", "minZoom", "maxZoom", "maxNativeZoom", "tileSize", "opacity", "subdomains", "noWrap", "tms"], path);
    result.url = string(required(source, "url", path), `${path}.url`, { nonEmpty: true });
    for (const key of ["minZoom", "maxZoom", "maxNativeZoom"] as const) {
      if (source[key] !== undefined) result[key] = number(source[key], `${path}.${key}`, { min: 0 });
    }
    if (source.tileSize !== undefined) result.tileSize = number(source.tileSize, `${path}.tileSize`, { min: 1 });
    if (source.opacity !== undefined) result.opacity = number(source.opacity, `${path}.opacity`, { min: 0, max: 1 });
    if (source.subdomains !== undefined) {
      if (typeof source.subdomains === "string") result.subdomains = source.subdomains;
      else if (Array.isArray(source.subdomains)) result.subdomains = source.subdomains.map((entry, index) => string(entry, `${path}.subdomains[${index}]`));
      else fail("INVALID_TYPE", `${path}.subdomains`, "Expected a string or string array", source.subdomains);
    }
    if (source.noWrap !== undefined) result.noWrap = boolean(source.noWrap, `${path}.noWrap`);
    if (source.tms !== undefined) result.tms = boolean(source.tms, `${path}.tms`);
  }
  return result as unknown as AILayerSpec | AILayerDescription;
}

function basemap(value: unknown, path: string): AIBasemapSpec {
  const parsed = layer({ id: "basemap", ...object(value, path) }, path, true) as AILayerSpec;
  if (parsed.type !== "raster") fail("INVALID_VALUE", `${path}.type`, "AI basemap type must be raster", parsed.type);
  const { id: _id, popup: _popup, tooltip: _tooltip, ...result } = parsed;
  return result;
}

export function validateScene(value: unknown, path = "$scene"): AISceneSpec {
  json(value, path);
  const source = object(value, path);
  keys(source, ["version", "camera", "basemap", "layers"], path);
  if (required(source, "version", path) !== 1) fail("INVALID_VALUE", `${path}.version`, "Only scene version 1 is supported", source.version);
  const layersValue = required(source, "layers", path);
  if (!Array.isArray(layersValue)) fail("INVALID_TYPE", `${path}.layers`, "Expected an array", layersValue);
  const layers = layersValue.map((entry, index) => layer(entry, `${path}.layers[${index}]`, true) as AILayerSpec);
  const seen = new Set<string>();
  for (let index = 0; index < layers.length; index++) {
    if (seen.has(layers[index].id)) fail("DUPLICATE_ID", `${path}.layers[${index}].id`, `Duplicate layer ID "${layers[index].id}"`, layers[index].id);
    seen.add(layers[index].id);
  }
  const result: AISceneSpec = { version: 1, layers };
  if (source.camera !== undefined) {
    const camera = object(source.camera, `${path}.camera`);
    keys(camera, ["center", "zoom"], `${path}.camera`);
    result.camera = {
      center: position(required(camera, "center", `${path}.camera`), `${path}.camera.center`),
      zoom: number(required(camera, "zoom", `${path}.camera`), `${path}.camera.zoom`, { min: 0 })
    };
  }
  if (source.basemap === null) result.basemap = null;
  else if (source.basemap !== undefined) result.basemap = basemap(source.basemap, `${path}.basemap`);
  return result;
}

function ids(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path, "Expected an array of IDs", value);
  return value.map((entry, index) => id(entry, `${path}[${index}]`));
}

export function validateLayer(value: unknown, path = "$layer"): AILayerSpec {
  json(value, path);
  return layer(value, path, true) as AILayerSpec;
}

export function validateLayerDescription(value: unknown, path = "$layer"): AILayerDescription {
  json(value, path);
  return layer(value, path, false) as AILayerDescription;
}

export function validateCommand(value: unknown, path = "$command"): AICommand {
  json(value, path);
  const source = object(value, path);
  const op = string(required(source, "op", path), `${path}.op`);
  if (op === "set_view") {
    keys(source, ["op", "center", "zoom"], path);
    return { op, center: position(required(source, "center", path), `${path}.center`), zoom: number(required(source, "zoom", path), `${path}.zoom`, { min: 0 }) };
  }
  if (op === "fly_to") {
    keys(source, ["op", "center", "zoom", "durationMs"], path);
    return {
      op,
      center: position(required(source, "center", path), `${path}.center`),
      ...optional(source.zoom, `${path}.zoom`, (entry, nextPath) => number(entry, nextPath, { min: 0 })) === undefined ? {} : { zoom: number(source.zoom, `${path}.zoom`, { min: 0 }) },
      ...optional(source.durationMs, `${path}.durationMs`, (entry, nextPath) => number(entry, nextPath, { min: 0 })) === undefined ? {} : { durationMs: number(source.durationMs, `${path}.durationMs`, { min: 0 }) }
    };
  }
  if (op === "add") {
    keys(source, ["op", "id", "layer"], path);
    return { op, id: id(required(source, "id", path), `${path}.id`), layer: validateLayerDescription(required(source, "layer", path), `${path}.layer`) };
  }
  if (op === "update") {
    keys(source, ["op", "id", "patch"], path);
    const patch = object(required(source, "patch", path), `${path}.patch`);
    if ("id" in patch || "type" in patch) fail("INVALID_VALUE", `${path}.patch`, "Layer id and type cannot be updated", patch);
    return { op, id: id(required(source, "id", path), `${path}.id`), patch: json(patch, `${path}.patch`) as Record<string, unknown> };
  }
  if (op === "remove") {
    keys(source, ["op", "id"], path);
    return { op, id: id(required(source, "id", path), `${path}.id`) };
  }
  if (op === "clear") {
    keys(source, ["op", "ids"], path);
    return { op, ...(source.ids === undefined ? {} : { ids: ids(source.ids, `${path}.ids`) }) };
  }
  if (op === "fit") {
    keys(source, ["op", "ids", "padding", "animation", "durationMs"], path);
    const result: Extract<AICommand, { op: "fit" }> = { op };
    if (source.ids !== undefined) result.ids = ids(source.ids, `${path}.ids`);
    if (source.padding !== undefined) result.padding = number(source.padding, `${path}.padding`, { min: 0 });
    if (source.animation !== undefined) {
      const animation = string(source.animation, `${path}.animation`);
      if (animation !== "none" && animation !== "fly") fail("INVALID_VALUE", `${path}.animation`, "Expected none or fly", animation);
      result.animation = animation;
    }
    if (source.durationMs !== undefined) result.durationMs = number(source.durationMs, `${path}.durationMs`, { min: 0 });
    return result;
  }
  if (op === "query") {
    keys(source, ["op", "ids"], path);
    return { op, ...(source.ids === undefined ? {} : { ids: ids(source.ids, `${path}.ids`) }) };
  }
  if (op === "apply_scene") {
    keys(source, ["op", "scene"], path);
    return { op, scene: validateScene(required(source, "scene", path), `${path}.scene`) };
  }
  fail("INVALID_VALUE", `${path}.op`, "Unknown operation. Expected set_view, fly_to, add, update, remove, clear, fit, query or apply_scene", op);
}
