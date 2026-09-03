import { parseCssColor } from "../webgl-utils.js";
import type { ObjectLabelStyle, ObjectStyle } from "./object-types.js";
import { rejectStyleAliases } from "../style-contract.js";

export function validateObjectStyle(style: ObjectStyle): void {
  rejectStyleAliases(style, "point");
  if (style.line) rejectStyleAliases(style.line, "line");
  if (style.trail) rejectStyleAliases(style.trail, "line");
  if (style.image != null) {
    if (typeof style.image !== "object" || Array.isArray(style.image)) throw new TypeError("Object image style must be an object");
    if (typeof style.image.url !== "string" || !style.image.url.trim()) throw new TypeError("Object image URL must be a non-empty string");
    if (style.image.shape != null && style.image.shape !== "rectangle" && style.image.shape !== "circle") {
      throw new TypeError("Object image shape must be rectangle or circle");
    }
    if (style.image.fit != null && !["fill", "cover", "contain"].includes(style.image.fit)) {
      throw new TypeError("Object image fit must be fill, cover or contain");
    }
  }
  if (style.label && typeof style.label === "object" && style.label.display != null
    && style.label.display !== "always" && style.label.display !== "hover") {
    throw new TypeError("Object label display must be always or hover");
  }
}

export function normalizeLabel(value: ObjectStyle["label"]): ObjectLabelStyle | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : null;
  }
  const text = String(value.text ?? "").trim();
  return text ? value : null;
}

export function styleTint(style: ObjectStyle): readonly [number, number, number, number] {
  validateObjectStyle(style);
  const color = style.iconTint ?? style.fill ?? "#ffffff";
  const rgb = parseCssColor(color, { r: 255, g: 255, b: 255 });
  const rawOpacity = style.fillOpacity;
  const opacity = Number.isFinite(Number(rawOpacity)) ? Number(rawOpacity) : 1;
  return [rgb.r / 255, rgb.g / 255, rgb.b / 255, Math.max(0, Math.min(1, opacity))];
}
