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

function locale(
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
export const ruLocale = locale(
  "ru",
  "Интерактивная карта", "Приблизить", "Отдалить", "Показать моё местоположение", "Определение местоположения", "Местоположение недоступно",
  "Слои", "Базовые карты", "Дополнительные слои", "Закрыть окно", "м", "км", "фут", "ми"
);
export const arLocale = locale(
  "ar",
  "خريطة تفاعلية", "تكبير", "تصغير", "إظهار موقعي", "جارٍ تحديد الموقع", "الموقع غير متاح",
  "الطبقات", "الخرائط الأساسية", "الطبقات الإضافية", "إغلاق النافذة", "م", "كم", "قدم", "ميل"
);
export const trLocale = locale(
  "tr",
  "Etkileşimli harita", "Yakınlaştır", "Uzaklaştır", "Konumumu göster", "Konum belirleniyor", "Konum kullanılamıyor",
  "Katmanlar", "Temel haritalar", "Ek katmanlar", "Pencereyi kapat", "m", "km", "ft", "mi"
);
/** Simplified Chinese */
export const zhLocale = locale(
  "zh",
  "交互式地图", "放大", "缩小", "显示我的位置", "正在定位", "无法获取位置",
  "图层", "底图", "叠加图层", "关闭弹窗", "米", "公里", "英尺", "英里"
);
export const deLocale = locale(
  "de",
  "Interaktive Karte", "Vergrößern", "Verkleinern", "Meinen Standort anzeigen", "Standort wird ermittelt", "Standort nicht verfügbar",
  "Ebenen", "Basiskarten", "Überlagerungen", "Popup schließen", "m", "km", "ft", "mi"
);
export const frLocale = locale(
  "fr",
  "Carte interactive", "Zoom avant", "Zoom arrière", "Afficher ma position", "Localisation en cours", "Position indisponible",
  "Couches", "Fonds de carte", "Superpositions", "Fermer la fenêtre", "m", "km", "pi", "mi"
);
export const daLocale = locale(
  "da",
  "Interaktivt kort", "Zoom ind", "Zoom ud", "Vis min placering", "Finder placering", "Placering er utilgængelig",
  "Lag", "Grundkort", "Overlejringer", "Luk popup", "m", "km", "ft", "mi"
);
export const hiLocale = locale(
  "hi",
  "इंटरैктив मानचित्र", "ज़ूम इन", "ज़ूम आउट", "मेरा स्थान दिखाएँ", "स्थान निर्धारित हो रहा है", "स्थान उपलब्ध नहीं है",
  "परतें", "आधार मानचित्र", "अतिरिक्त परतें", "पॉपअप बंद करें", "मी", "किमी", "फ़ुट", "मील"
);

export const locales: Readonly<Record<LocaleName, Readonly<OrihonLocale>>> = Object.freeze({
  en: enLocale,
  ru: ruLocale,
  ar: arLocale,
  tr: trLocale,
  zh: zhLocale,
  de: deLocale,
  fr: frLocale,
  da: daLocale,
  hi: hiLocale
});

export function resolveLocale(input: LocaleInput = "en"): OrihonLocale {
  if (typeof input === "string") {
    return { ...(locales[input] ?? enLocale) };
  }
  return { ...enLocale, ...input };
}
