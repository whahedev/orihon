import type { LocaleName } from "../ui/locale.js";
import { locales } from "../ui/locale.js";

export interface DrawLocale {
  drawPoint: string;
  drawLine: string;
  drawPolygon: string;
  drawRectangle: string;
  drawCircle: string;
  drawEdit: string;
  drawDelete: string;
  drawFinish: string;
  drawCancel: string;
  drawUndo: string;
  drawRedo: string;
}

export type DrawLocaleInput = LocaleName | Partial<DrawLocale>;

const drawLocales: Record<LocaleName, DrawLocale> = {
  en: { drawPoint: "Draw point", drawLine: "Draw line", drawPolygon: "Draw polygon", drawRectangle: "Draw rectangle", drawCircle: "Draw circle", drawEdit: "Edit features", drawDelete: "Delete features", drawFinish: "Finish drawing", drawCancel: "Cancel drawing", drawUndo: "Undo", drawRedo: "Redo" },
  ru: { drawPoint: "Нарисовать точку", drawLine: "Нарисовать линию", drawPolygon: "Нарисовать полигон", drawRectangle: "Нарисовать прямоугольник", drawCircle: "Нарисовать круг", drawEdit: "Редактировать объекты", drawDelete: "Удалить объекты", drawFinish: "Завершить рисование", drawCancel: "Отменить рисование", drawUndo: "Отменить действие", drawRedo: "Повторить действие" },
  ar: { drawPoint: "رسم نقطة", drawLine: "رسم خط", drawPolygon: "رسم مضلع", drawRectangle: "رسم مستطيل", drawCircle: "رسم دائرة", drawEdit: "تحرير المعالم", drawDelete: "حذف المعالم", drawFinish: "إنهاء الرسم", drawCancel: "إلغاء الرسم", drawUndo: "تراجع", drawRedo: "إعادة" },
  tr: { drawPoint: "Nokta çiz", drawLine: "Çizgi çiz", drawPolygon: "Çokgen çiz", drawRectangle: "Dikdörtgen çiz", drawCircle: "Daire çiz", drawEdit: "Özellikleri düzenle", drawDelete: "Özellikleri sil", drawFinish: "Çizimi bitir", drawCancel: "Çizimi iptal et", drawUndo: "Geri al", drawRedo: "Yinele" },
  zh: { drawPoint: "绘制点", drawLine: "绘制线", drawPolygon: "绘制多边形", drawRectangle: "绘制矩形", drawCircle: "绘制圆形", drawEdit: "编辑要素", drawDelete: "删除要素", drawFinish: "完成绘制", drawCancel: "取消绘制", drawUndo: "撤销", drawRedo: "重做" },
  de: { drawPoint: "Punkt zeichnen", drawLine: "Linie zeichnen", drawPolygon: "Polygon zeichnen", drawRectangle: "Rechteck zeichnen", drawCircle: "Kreis zeichnen", drawEdit: "Objekte bearbeiten", drawDelete: "Objekte löschen", drawFinish: "Zeichnen beenden", drawCancel: "Zeichnen abbrechen", drawUndo: "Rückgängig", drawRedo: "Wiederholen" },
  fr: { drawPoint: "Dessiner un point", drawLine: "Dessiner une ligne", drawPolygon: "Dessiner un polygone", drawRectangle: "Dessiner un rectangle", drawCircle: "Dessiner un cercle", drawEdit: "Modifier les objets", drawDelete: "Supprimer les objets", drawFinish: "Terminer le dessin", drawCancel: "Annuler le dessin", drawUndo: "Annuler", drawRedo: "Rétablir" },
  da: { drawPoint: "Tegn punkt", drawLine: "Tegn linje", drawPolygon: "Tegn polygon", drawRectangle: "Tegn rektangel", drawCircle: "Tegn cirkel", drawEdit: "Rediger objekter", drawDelete: "Slet objekter", drawFinish: "Afslut tegning", drawCancel: "Annuller tegning", drawUndo: "Fortryd", drawRedo: "Gentag" },
  hi: { drawPoint: "बिंदु बनाएँ", drawLine: "रेखा बनाएँ", drawPolygon: "बहुभुज बनाएँ", drawRectangle: "आयत बनाएँ", drawCircle: "वृत्त बनाएँ", drawEdit: "फ़ीचर संपादित करें", drawDelete: "फ़ीचर हटाएँ", drawFinish: "चित्र पूरा करें", drawCancel: "चित्र रद्द करें", drawUndo: "पूर्ववत करें", drawRedo: "फिर करें" }
};

export const enDrawLocale = drawLocales.en;

export function resolveDrawLocale(input: DrawLocaleInput = "en"): DrawLocale {
  if (typeof input === "string") return { ...(drawLocales[input] ?? drawLocales.en) };
  return { ...drawLocales.en, ...input };
}

/** Infer draw locale from a map control locale object via its mapLabel. */
export function drawLocaleFromMapLabel(mapLabel: string | undefined): DrawLocale {
  if (!mapLabel) return resolveDrawLocale("en");
  for (const [name, preset] of Object.entries(locales) as Array<[LocaleName, { mapLabel: string }]>) {
    if (preset.mapLabel === mapLabel) return resolveDrawLocale(name);
  }
  return resolveDrawLocale("en");
}
