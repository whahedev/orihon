import { parseCssColor } from "../webgl-utils.js";
import type { ObjectLabelStyle, ObjectStyle } from "./object-types.js";
import { rejectStyleAliases } from "../style-contract.js";

export function validateObjectStyle(style: ObjectStyle): void {
  rejectStyleAliases(style, "point");
  if (style.line) rejectStyleAliases(style.line, "line");
  if (style.trail) rejectStyleAliases(style.trail, "line");
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
