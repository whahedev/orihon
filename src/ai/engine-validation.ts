import { AIError } from "./errors.js";
import type {
  AIEngineCommand,
  AIObjectBatchChange,
  AIObjectCommand,
  AIObjectFeature,
  AIPopupImage,
  AIPointCategory,
  AIPointDefaults,
  AIPointPatch,
  AIPointPopup,
  AIPointSpec,
  AIPointVisual,
  AIPointVisualDefaults,
  AIPointVisualImage,
  AIPointVisualLabel,
  AIPointViewport,
  AIPointsReplaceCommand,
  AIRoutePlanCommand
} from "./types.js";
import { validateCommand } from "./validation.js";

type JSONObject = Record<string, unknown>;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code: ConstructorParameters<typeof AIError>[0], path: string, message: string, received?: unknown): never {
  throw new AIError(code, path, message, received);
}

function object(value: unknown, path: string): JSONObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_TYPE", path, "Expected an object", value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("NOT_JSON", path, "Expected a plain JSON object", value);
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

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail("INVALID_TYPE", path, "Expected a string", value);
  return value;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  const result = string(value, path);
  if (result.length > maxLength) fail("INVALID_VALUE", path, `String must be at most ${maxLength} characters`, value);
  return result;
}

function name(value: unknown, path: string): string {
  const result = string(value, path);
  if (!NAME_PATTERN.test(result)) {
    fail("INVALID_VALUE", path, "Name must be 1-128 characters and contain only letters, numbers, '.', '_', ':' or '-'", value);
  }
  return result;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("INVALID_TYPE", path, "Expected a finite number", value);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("INVALID_TYPE", path, "Expected a boolean", value);
  return value;
}

function json(value: unknown, path: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, path);
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

function id(value: unknown, path: string): string | number {
  if (typeof value === "string") return name(value, path);
  return finite(value, path);
}

function coordinate(value: unknown, path: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2) fail("INVALID_COORDINATE", path, "Expected GeoJSON [longitude, latitude]", value);
  const lng = finite(value[0], `${path}[0]`);
  const lat = finite(value[1], `${path}[1]`);
  if (lng < -180 || lng > 180) fail("INVALID_COORDINATE", `${path}[0]`, "Longitude must be between -180 and 180", lng);
  if (lat < -90 || lat > 90) fail("INVALID_COORDINATE", `${path}[1]`, "Latitude must be between -90 and 90", lat);
  return [lng, lat];
}

function geometry(value: unknown, path: string): AIObjectFeature["geometry"] {
  const source = object(value, path);
  keys(source, ["type", "coordinates"], path);
  const type = string(required(source, "type", path), `${path}.type`);
  const coordinates = required(source, "coordinates", path);
  if (type === "Point") return { type, coordinates: coordinate(coordinates, `${path}.coordinates`) };
  if (type === "LineString") {
    if (!Array.isArray(coordinates) || coordinates.length < 2) fail("INVALID_COORDINATE", `${path}.coordinates`, "LineString requires at least two positions", coordinates);
    return { type, coordinates: coordinates.map((entry, index) => coordinate(entry, `${path}.coordinates[${index}]`)) };
  }
  if (type === "Polygon") {
    if (!Array.isArray(coordinates) || coordinates.length === 0) fail("INVALID_COORDINATE", `${path}.coordinates`, "Polygon requires at least one ring", coordinates);
    return {
      type,
      coordinates: coordinates.map((ring, ringIndex) => {
        if (!Array.isArray(ring) || ring.length < 3) fail("INVALID_COORDINATE", `${path}.coordinates[${ringIndex}]`, "Polygon ring requires at least three positions", ring);
        return ring.map((entry, index) => coordinate(entry, `${path}.coordinates[${ringIndex}][${index}]`));
      })
    };
  }
  fail("INVALID_VALUE", `${path}.type`, "ObjectManager supports Point, LineString and Polygon geometries", type);
}

function feature(value: unknown, path: string): AIObjectFeature {
  const source = object(value, path);
  keys(source, ["type", "id", "geometry", "properties"], path);
  if (required(source, "type", path) !== "Feature") fail("INVALID_VALUE", `${path}.type`, "Expected GeoJSON Feature", source.type);
  const result: AIObjectFeature = {
    type: "Feature",
    id: id(required(source, "id", path), `${path}.id`),
    geometry: geometry(required(source, "geometry", path), `${path}.geometry`)
  };
  if (source.properties === null) result.properties = null;
  else if (source.properties !== undefined) result.properties = json(object(source.properties, `${path}.properties`), `${path}.properties`) as Record<string, unknown>;
  return result;
}

function features(value: unknown, path: string): AIObjectFeature[] {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path, "Expected an array of GeoJSON features", value);
  const result = value.map((entry, index) => feature(entry, `${path}[${index}]`));
  const seen = new Set<string | number>();
  for (let index = 0; index < result.length; index++) {
    if (seen.has(result[index].id)) fail("DUPLICATE_ID", `${path}[${index}].id`, `Duplicate object ID "${String(result[index].id)}"`, result[index].id);
    seen.add(result[index].id);
  }
  return result;
}

function ids(value: unknown, path: string): Array<string | number> {
  if (!Array.isArray(value)) fail("INVALID_TYPE", path, "Expected an array of object IDs", value);
  const result = value.map((entry, index) => id(entry, `${path}[${index}]`));
  const seen = new Set<string | number>();
  for (let index = 0; index < result.length; index++) {
    if (seen.has(result[index])) fail("DUPLICATE_ID", `${path}[${index}]`, `Duplicate object ID "${String(result[index])}"`, result[index]);
    seen.add(result[index]);
  }
  return result;
}

function pointCategory(value: unknown, path: string): AIPointCategory {
  const result = string(value, path);
  if (result !== "alpha" && result !== "beta" && result !== "gamma" && result !== "alert") {
    fail("INVALID_VALUE", path, "Expected alpha, beta, gamma or alert", value);
  }
  return result;
}

function popupImageURL(value: unknown, path: string): string {
  const result = boundedString(value, path, 2048);
  const normalized = result.trim();
  if (!normalized || /[\u0000-\u001f\u007f\\]/.test(normalized)) {
    fail("INVALID_VALUE", path, "Popup image URL must be a non-empty HTTPS or local URL", value);
  }
  const local = (normalized.startsWith("/") && !normalized.startsWith("//")) ||
    normalized.startsWith("./") || normalized.startsWith("../");
  if (!local) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      fail("INVALID_VALUE", path, "Popup image URL must use HTTPS or be local", value);
    }
    if (parsed.protocol !== "https:") {
      fail("INVALID_VALUE", path, "Popup image URL must use HTTPS or be local", value);
    }
  }
  return normalized;
}

function popupImage(value: unknown, path: string): AIPopupImage {
  const source = object(value, path);
  keys(source, ["url", "alt", "caption"], path);
  const result: AIPopupImage = { url: popupImageURL(required(source, "url", path), `${path}.url`) };
  if (source.alt !== undefined) result.alt = boundedString(source.alt, `${path}.alt`, 500);
  if (source.caption !== undefined) result.caption = boundedString(source.caption, `${path}.caption`, 1000);
  return result;
}

function pointPopup(value: unknown, path: string): AIPointPopup {
  if (typeof value === "string") return value;
  const source = object(value, path);
  keys(source, ["text", "image"], path);
  if (source.text === undefined && source.image === undefined) {
    fail("REQUIRED_PROPERTY", path, "Rich popup requires text or image", value);
  }
  const result: Exclude<AIPointPopup, string> = {};
  if (source.text !== undefined) result.text = boundedString(source.text, `${path}.text`, 4000);
  if (source.image !== undefined) result.image = popupImage(source.image, `${path}.image`);
  return result;
}

function visualColor(value: unknown, path: string): string {
  const result = boundedString(value, path, 64).trim();
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) fail("INVALID_VALUE", path, "Expected a safe CSS color", value);
  return result;
}

function boundedNumber(value: unknown, path: string, min: number, max: number): number {
  const result = finite(value, path);
  if (result < min || result > max) fail("INVALID_VALUE", path, `Expected a number from ${min} to ${max}`, value);
  return result;
}

function pointVisualImage(value: unknown, path: string): AIPointVisualImage {
  const source = object(value, path);
  keys(source, ["url", "alt", "shape", "fit", "borderColor", "borderWidth"], path);
  const result: AIPointVisualImage = { url: popupImageURL(required(source, "url", path), `${path}.url`) };
  if (source.alt !== undefined) result.alt = boundedString(source.alt, `${path}.alt`, 500);
  if (source.shape !== undefined) {
    const shape = string(source.shape, `${path}.shape`);
    if (shape !== "circle" && shape !== "rectangle") fail("INVALID_VALUE", `${path}.shape`, "Expected circle or rectangle", shape);
    result.shape = shape;
  }
  if (source.fit !== undefined) {
    const fit = string(source.fit, `${path}.fit`);
    if (fit !== "cover" && fit !== "contain" && fit !== "fill") fail("INVALID_VALUE", `${path}.fit`, "Expected cover, contain or fill", fit);
    result.fit = fit;
  }
  if (source.borderColor !== undefined) result.borderColor = visualColor(source.borderColor, `${path}.borderColor`);
  if (source.borderWidth !== undefined) result.borderWidth = boundedNumber(source.borderWidth, `${path}.borderWidth`, 0, 16);
  return result;
}

function pointVisualLabel(value: unknown, path: string): string | AIPointVisualLabel {
  if (typeof value === "string") return boundedString(value, path, 500);
  const source = object(value, path);
  keys(source, ["text", "display", "fontSize", "fontWeight", "color", "haloColor", "haloWidth", "offset", "priority", "minZoom", "maxZoom"], path);
  const result: AIPointVisualLabel = {};
  if (source.text !== undefined) result.text = boundedString(source.text, `${path}.text`, 500);
  if (source.display !== undefined) {
    const display = string(source.display, `${path}.display`);
    if (display !== "hover" && display !== "always") fail("INVALID_VALUE", `${path}.display`, "Expected hover or always", display);
    result.display = display;
  }
  if (source.fontSize !== undefined) result.fontSize = boundedNumber(source.fontSize, `${path}.fontSize`, 8, 48);
  if (source.fontWeight !== undefined) result.fontWeight = boundedNumber(source.fontWeight, `${path}.fontWeight`, 100, 900);
  if (source.color !== undefined) result.color = visualColor(source.color, `${path}.color`);
  if (source.haloColor !== undefined) result.haloColor = visualColor(source.haloColor, `${path}.haloColor`);
  if (source.haloWidth !== undefined) result.haloWidth = boundedNumber(source.haloWidth, `${path}.haloWidth`, 0, 8);
  if (source.offset !== undefined) {
    const offset = object(source.offset, `${path}.offset`);
    keys(offset, ["x", "y"], `${path}.offset`);
    result.offset = {
      x: boundedNumber(required(offset, "x", `${path}.offset`), `${path}.offset.x`, -256, 256),
      y: boundedNumber(required(offset, "y", `${path}.offset`), `${path}.offset.y`, -256, 256)
    };
  }
  if (source.priority !== undefined) result.priority = boundedNumber(source.priority, `${path}.priority`, -1000000, 1000000);
  if (source.minZoom !== undefined) result.minZoom = boundedNumber(source.minZoom, `${path}.minZoom`, 0, 30);
  if (source.maxZoom !== undefined) result.maxZoom = boundedNumber(source.maxZoom, `${path}.maxZoom`, 0, 30);
  if (result.minZoom !== undefined && result.maxZoom !== undefined && result.minZoom > result.maxZoom) {
    fail("INVALID_VALUE", `${path}.minZoom`, "minZoom must not exceed maxZoom", result.minZoom);
  }
  return result;
}

function pointVisual(value: unknown, path: string): AIPointVisual {
  const source = object(value, path);
  keys(source, ["image", "label", "size", "collisionMode"], path);
  if (source.image === undefined && source.label === undefined) fail("REQUIRED_PROPERTY", path, "Point visual requires image or label", value);
  const result: AIPointVisual = {};
  if (source.image !== undefined) result.image = pointVisualImage(source.image, `${path}.image`);
  if (source.label !== undefined) result.label = pointVisualLabel(source.label, `${path}.label`);
  if (source.size !== undefined) result.size = boundedNumber(source.size, `${path}.size`, 8, 256);
  if (source.collisionMode !== undefined) {
    const mode = string(source.collisionMode, `${path}.collisionMode`);
    if (mode !== "auto" && mode !== "always" && mode !== "hide") fail("INVALID_VALUE", `${path}.collisionMode`, "Expected auto, always or hide", mode);
    result.collisionMode = mode;
  }
  return result;
}

function namedPosition(value: unknown, path: string): { lat: number; lng: number } {
  const source = object(value, path);
  keys(source, ["lat", "lng"], path);
  const lat = finite(required(source, "lat", path), `${path}.lat`);
  const lng = finite(required(source, "lng", path), `${path}.lng`);
  if (lat < -90 || lat > 90) fail("INVALID_COORDINATE", `${path}.lat`, "Latitude must be between -90 and 90", lat);
  if (lng < -180 || lng > 180) fail("INVALID_COORDINATE", `${path}.lng`, "Longitude must be between -180 and 180", lng);
  return { lat, lng };
}

function point(value: unknown, path: string): AIPointSpec {
  const source = object(value, path);
  keys(source, ["id", "position", "title", "popup", "visual", "category"], path);
  const result: AIPointSpec = {
    id: id(required(source, "id", path), `${path}.id`),
    position: namedPosition(required(source, "position", path), `${path}.position`)
  };
  if (source.title !== undefined) result.title = string(source.title, `${path}.title`);
  if (source.popup !== undefined) result.popup = pointPopup(source.popup, `${path}.popup`);
  if (source.visual !== undefined) result.visual = pointVisual(source.visual, `${path}.visual`);
  if (source.category !== undefined) result.category = pointCategory(source.category, `${path}.category`);
  return result;
}

function pointVisualDefaults(value: unknown, path: string): AIPointVisualDefaults {
  const source = object(value, path);
  keys(source, ["image", "label", "size", "collisionMode"], path);
  if (source.image === undefined && source.label === undefined && source.size === undefined && source.collisionMode === undefined) {
    fail("REQUIRED_PROPERTY", path, "Point visual defaults require image, label, size or collisionMode", value);
  }
  const result: AIPointVisualDefaults = {};
  if (source.image !== undefined) {
    const image = object(source.image, `${path}.image`);
    keys(image, ["url", "alt", "shape", "fit", "borderColor", "borderWidth"], `${path}.image`);
    const next: NonNullable<AIPointVisualDefaults["image"]> = {};
    if (image.url !== undefined) next.url = popupImageURL(image.url, `${path}.image.url`);
    if (image.alt !== undefined) next.alt = boundedString(image.alt, `${path}.image.alt`, 500);
    if (image.shape !== undefined) {
      const shape = string(image.shape, `${path}.image.shape`);
      if (shape !== "circle" && shape !== "rectangle") fail("INVALID_VALUE", `${path}.image.shape`, "Expected circle or rectangle", shape);
      next.shape = shape;
    }
    if (image.fit !== undefined) {
      const fit = string(image.fit, `${path}.image.fit`);
      if (fit !== "cover" && fit !== "contain" && fit !== "fill") fail("INVALID_VALUE", `${path}.image.fit`, "Expected cover, contain or fill", fit);
      next.fit = fit;
    }
    if (image.borderColor !== undefined) next.borderColor = visualColor(image.borderColor, `${path}.image.borderColor`);
    if (image.borderWidth !== undefined) next.borderWidth = boundedNumber(image.borderWidth, `${path}.image.borderWidth`, 0, 16);
    result.image = next;
  }
  if (source.label !== undefined) result.label = pointVisualLabel(source.label, `${path}.label`);
  if (source.size !== undefined) result.size = boundedNumber(source.size, `${path}.size`, 8, 256);
  if (source.collisionMode !== undefined) {
    const mode = string(source.collisionMode, `${path}.collisionMode`);
    if (mode !== "auto" && mode !== "always" && mode !== "hide") fail("INVALID_VALUE", `${path}.collisionMode`, "Expected auto, always or hide", mode);
    result.collisionMode = mode;
  }
  return result;
}

function pointDefaults(value: unknown, path: string): AIPointDefaults {
  const source = object(value, path);
  keys(source, ["category", "visual"], path);
  const result: AIPointDefaults = {};
  if (source.category !== undefined) result.category = pointCategory(source.category, `${path}.category`);
  if (source.visual !== undefined) result.visual = pointVisualDefaults(source.visual, `${path}.visual`);
  return result;
}

function pointPatch(value: unknown, path: string): AIPointPatch {
  const source = object(value, path);
  keys(source, ["id", "position", "title", "popup", "visual", "category"], path);
  const result: AIPointPatch = {
    id: id(required(source, "id", path), `${path}.id`)
  };
  if (source.position !== undefined) result.position = namedPosition(source.position, `${path}.position`);
  if (source.title !== undefined) result.title = string(source.title, `${path}.title`);
  if (source.popup !== undefined) result.popup = pointPopup(source.popup, `${path}.popup`);
  if (source.visual !== undefined) result.visual = pointVisual(source.visual, `${path}.visual`);
  if (source.category !== undefined) result.category = pointCategory(source.category, `${path}.category`);
  if (result.position === undefined && result.title === undefined && result.popup === undefined
    && result.visual === undefined && result.category === undefined) {
    fail("REQUIRED_PROPERTY", path, "Point patch requires at least one field besides id", value);
  }
  return result;
}

export function validatePointPatches(value: unknown, path = "$points"): AIPointPatch[] {
  if (!Array.isArray(value) || value.length < 1) fail("INVALID_VALUE", path, "Expected a non-empty array of point patches", value);
  const patches = value.map((entry, index) => pointPatch(entry, `${path}[${index}]`));
  const seen = new Set<string | number>();
  for (let index = 0; index < patches.length; index++) {
    if (seen.has(patches[index].id)) fail("DUPLICATE_ID", `${path}[${index}].id`, `Duplicate point ID "${String(patches[index].id)}"`, patches[index].id);
    seen.add(patches[index].id);
  }
  return patches;
}

function pointViewport(value: unknown, path: string): AIPointViewport {
  const source = object(value, path);
  keys(source, ["mode", "padding", "animation", "durationMs"], path);
  if (required(source, "mode", path) !== "fit") fail("INVALID_VALUE", `${path}.mode`, "Expected fit", source.mode);
  const result: AIPointViewport = { mode: "fit" };
  if (source.padding !== undefined) {
    result.padding = finite(source.padding, `${path}.padding`);
    if (result.padding < 0) fail("INVALID_VALUE", `${path}.padding`, "Padding must be non-negative", result.padding);
  }
  if (source.animation !== undefined) {
    const animation = string(source.animation, `${path}.animation`);
    if (animation !== "none" && animation !== "fly") fail("INVALID_VALUE", `${path}.animation`, "Expected none or fly", animation);
    result.animation = animation;
  }
  if (source.durationMs !== undefined) {
    result.durationMs = finite(source.durationMs, `${path}.durationMs`);
    if (result.durationMs < 0) fail("INVALID_VALUE", `${path}.durationMs`, "Duration must be non-negative", result.durationMs);
  }
  return result;
}

export function validatePointsReplaceCommand(value: unknown, path = "$command"): AIPointsReplaceCommand {
  json(value, path);
  const source = object(value, path);
  keys(source, ["op", "collection", "points", "defaults", "viewport", "clearMap"], path);
  if (required(source, "op", path) !== "points.replace") fail("INVALID_VALUE", `${path}.op`, "Expected points.replace", source.op);
  const entries = required(source, "points", path);
  if (!Array.isArray(entries)) fail("INVALID_TYPE", `${path}.points`, "Expected an array of points", entries);
  const points = entries.map((entry, index) => point(entry, `${path}.points[${index}]`));
  const seen = new Set<string | number>();
  for (let index = 0; index < points.length; index++) {
    if (seen.has(points[index].id)) fail("DUPLICATE_ID", `${path}.points[${index}].id`, `Duplicate point ID "${String(points[index].id)}"`, points[index].id);
    seen.add(points[index].id);
  }
  const result: AIPointsReplaceCommand = {
    op: "points.replace",
    collection: name(required(source, "collection", path), `${path}.collection`),
    points
  };
  if (source.defaults !== undefined) result.defaults = pointDefaults(source.defaults, `${path}.defaults`);
  if (source.viewport !== undefined) {
    result.viewport = pointViewport(source.viewport, `${path}.viewport`);
    if (points.length === 0) fail("EMPTY_SELECTION", `${path}.points`, "Viewport fit requires at least one point", points);
  }
  if (source.clearMap !== undefined) result.clearMap = boolean(source.clearMap, `${path}.clearMap`);
  return result;
}

function batchChange(value: unknown, path: string): AIObjectBatchChange {
  const source = object(value, path);
  const type = string(required(source, "type", path), `${path}.type`);
  if (type === "add" || type === "update") {
    keys(source, ["type", "objects"], path);
    return { type, objects: features(required(source, "objects", path), `${path}.objects`) };
  }
  if (type === "remove") {
    keys(source, ["type", "ids"], path);
    return { type, ids: ids(required(source, "ids", path), `${path}.ids`) };
  }
  fail("INVALID_VALUE", `${path}.type`, "Expected add, update or remove", type);
}

export function validateObjectCommand(value: unknown, path = "$command"): AIObjectCommand {
  json(value, path);
  const source = object(value, path);
  const op = string(required(source, "op", path), `${path}.op`);
  const collection = name(required(source, "collection", path), `${path}.collection`);
  if (op === "objects.add" || op === "objects.update" || op === "objects.replace") {
    keys(source, ["op", "collection", "objects"], path);
    return { op, collection, objects: features(required(source, "objects", path), `${path}.objects`) };
  }
  if (op === "objects.remove") {
    keys(source, ["op", "collection", "ids"], path);
    return { op, collection, ids: ids(required(source, "ids", path), `${path}.ids`) };
  }
  if (op === "objects.clear") {
    keys(source, ["op", "collection"], path);
    return { op, collection };
  }
  if (op === "objects.batch") {
    keys(source, ["op", "collection", "changes"], path);
    const changes = required(source, "changes", path);
    if (!Array.isArray(changes)) fail("INVALID_TYPE", `${path}.changes`, "Expected an array of changes", changes);
    return { op, collection, changes: changes.map((entry, index) => batchChange(entry, `${path}.changes[${index}]`)) };
  }
  fail("INVALID_VALUE", `${path}.op`, "Unknown object operation", op);
}

export function validateRoutePlanCommand(value: unknown, path = "$command"): AIRoutePlanCommand {
  json(value, path);
  const source = object(value, path);
  keys(source, ["op", "routeId", "collection", "ids", "startId", "endId", "optimize", "closeLoop", "annotateStops", "reactive"], path);
  if (required(source, "op", path) !== "route.plan") fail("INVALID_VALUE", `${path}.op`, "Expected route.plan", source.op);
  const result: AIRoutePlanCommand = {
    op: "route.plan",
    routeId: name(required(source, "routeId", path), `${path}.routeId`),
    collection: name(required(source, "collection", path), `${path}.collection`)
  };
  if (source.ids !== undefined) result.ids = ids(source.ids, `${path}.ids`);
  if (source.startId !== undefined) result.startId = id(source.startId, `${path}.startId`);
  if (source.endId !== undefined) result.endId = id(source.endId, `${path}.endId`);
  if (source.optimize !== undefined) {
    if (source.optimize !== "shortest") fail("INVALID_VALUE", `${path}.optimize`, "Expected shortest", source.optimize);
    result.optimize = "shortest";
  }
  if (source.closeLoop !== undefined) result.closeLoop = boolean(source.closeLoop, `${path}.closeLoop`);
  if (source.annotateStops !== undefined) result.annotateStops = boolean(source.annotateStops, `${path}.annotateStops`);
  if (source.reactive !== undefined) result.reactive = boolean(source.reactive, `${path}.reactive`);
  return result;
}

export function validateEngineCommand(value: unknown, path = "$command"): AIEngineCommand {
  const source = object(value, path);
  const op = string(required(source, "op", path), `${path}.op`);
  if (op === "points.replace") return validatePointsReplaceCommand(value, path);
  if (op === "route.plan") return validateRoutePlanCommand(value, path);
  return op.startsWith("objects.") ? validateObjectCommand(value, path) : validateCommand(value, path);
}
