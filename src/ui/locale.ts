export interface OrihonLocale {
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

export const enLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Interactive map",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  locate: "Show my location",
  locating: "Locating",
  locationError: "Location is unavailable",
  layers: "Layers",
  baseMaps: "Base maps",
  overlays: "Overlays",
  closePopup: "Close popup",
  meters: "m",
  kilometers: "km",
  feet: "ft",
  miles: "mi"
});

export const ruLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Интерактивная карта",
  zoomIn: "Приблизить",
  zoomOut: "Отдалить",
  locate: "Показать моё местоположение",
  locating: "Определение местоположения",
  locationError: "Местоположение недоступно",
  layers: "Слои",
  baseMaps: "Базовые карты",
  overlays: "Дополнительные слои",
  closePopup: "Закрыть окно",
  meters: "м",
  kilometers: "км",
  feet: "фут",
  miles: "ми"
});

export const arLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "خريطة تفاعلية",
  zoomIn: "تكبير",
  zoomOut: "تصغير",
  locate: "إظهار موقعي",
  locating: "جارٍ تحديد الموقع",
  locationError: "الموقع غير متاح",
  layers: "الطبقات",
  baseMaps: "الخرائط الأساسية",
  overlays: "الطبقات الإضافية",
  closePopup: "إغلاق النافذة",
  meters: "م",
  kilometers: "كم",
  feet: "قدم",
  miles: "ميل"
});

export const trLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Etkileşimli harita",
  zoomIn: "Yakınlaştır",
  zoomOut: "Uzaklaştır",
  locate: "Konumumu göster",
  locating: "Konum belirleniyor",
  locationError: "Konum kullanılamıyor",
  layers: "Katmanlar",
  baseMaps: "Temel haritalar",
  overlays: "Ek katmanlar",
  closePopup: "Pencereyi kapat",
  meters: "m",
  kilometers: "km",
  feet: "ft",
  miles: "mi"
});

/** Simplified Chinese */
export const zhLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "交互式地图",
  zoomIn: "放大",
  zoomOut: "缩小",
  locate: "显示我的位置",
  locating: "正在定位",
  locationError: "无法获取位置",
  layers: "图层",
  baseMaps: "底图",
  overlays: "叠加图层",
  closePopup: "关闭弹窗",
  meters: "米",
  kilometers: "公里",
  feet: "英尺",
  miles: "英里"
});

export const deLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Interaktive Karte",
  zoomIn: "Vergrößern",
  zoomOut: "Verkleinern",
  locate: "Meinen Standort anzeigen",
  locating: "Standort wird ermittelt",
  locationError: "Standort nicht verfügbar",
  layers: "Ebenen",
  baseMaps: "Basiskarten",
  overlays: "Überlagerungen",
  closePopup: "Popup schließen",
  meters: "m",
  kilometers: "km",
  feet: "ft",
  miles: "mi"
});

export const frLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Carte interactive",
  zoomIn: "Zoom avant",
  zoomOut: "Zoom arrière",
  locate: "Afficher ma position",
  locating: "Localisation en cours",
  locationError: "Position indisponible",
  layers: "Couches",
  baseMaps: "Fonds de carte",
  overlays: "Superpositions",
  closePopup: "Fermer la fenêtre",
  meters: "m",
  kilometers: "km",
  feet: "pi",
  miles: "mi"
});

export const daLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "Interaktivt kort",
  zoomIn: "Zoom ind",
  zoomOut: "Zoom ud",
  locate: "Vis min placering",
  locating: "Finder placering",
  locationError: "Placering er utilgængelig",
  layers: "Lag",
  baseMaps: "Grundkort",
  overlays: "Overlejringer",
  closePopup: "Luk popup",
  meters: "m",
  kilometers: "km",
  feet: "ft",
  miles: "mi"
});

export const hiLocale: Readonly<OrihonLocale> = Object.freeze({
  mapLabel: "इंटरैक्टिव मानचित्र",
  zoomIn: "ज़ूम इन",
  zoomOut: "ज़ूम आउट",
  locate: "मेरा स्थान दिखाएँ",
  locating: "स्थान निर्धारित हो रहा है",
  locationError: "स्थान उपलब्ध नहीं है",
  layers: "परतें",
  baseMaps: "आधार मानचित्र",
  overlays: "अतिरिक्त परतें",
  closePopup: "पॉपअप बंद करें",
  meters: "मी",
  kilometers: "किमी",
  feet: "फ़ुट",
  miles: "मील"
});

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
