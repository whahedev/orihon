import type { LocaleName, OrihonLocale } from "./locale-types.js";

export function locale(
  language: LocaleName,
  mapLabel: string,
  zoomIn: string,
  zoomOut: string,
  locate: string,
  locating: string,
  locationError: string,
  layers: string,
  baseMaps: string,
  overlays: string,
  closePopup: string,
  meters: string,
  kilometers: string,
  feet: string,
  miles: string
): Readonly<OrihonLocale> {
  return Object.freeze({
    language,
    rtl: language === "ar",
    mapLabel, zoomIn, zoomOut, locate, locating, locationError,
    layers, baseMaps, overlays, closePopup, meters, kilometers, feet, miles
  });
}

export const enLocale = locale(
  "en",
  "Interactive map", "Zoom in", "Zoom out", "Show my location", "Locating", "Location is unavailable",
  "Layers", "Base maps", "Overlays", "Close popup", "m", "km", "ft", "mi"
);
