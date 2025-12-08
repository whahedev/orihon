export interface OrihonLocale {
  language: LocaleName;
  rtl?: boolean;
  mapLabel: string;
  zoomIn: string;
  zoomOut: string;
  locate: string;
  locating: string;
  locationError: string;
  layers: string;
  baseMaps: string;
  overlays: string;
  closePopup: string;
  meters: string;
  kilometers: string;
  feet: string;
  miles: string;
}

/** Built-in UI locales. English (`en`) is the default. */
export type LocaleName = "en" | "ru" | "ar" | "tr" | "zh" | "de" | "fr" | "da" | "hi";
export type LocaleInput = LocaleName | Partial<OrihonLocale>;
