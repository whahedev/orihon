import type { LocaleInput, LocaleName, OrihonLocale } from "./locale-types.js";
import { enLocale } from "./locale-en.js";

export type { LocaleInput, LocaleName, OrihonLocale } from "./locale-types.js";
export { enLocale } from "./locale-en.js";

const packCache: Partial<Record<LocaleName, Readonly<OrihonLocale>>> = {
  en: enLocale
};

let packsLoading: Promise<void> | null = null;

/** Merge built-in or app-supplied locale tables (sync). */
export function registerLocalePacks(
  packs: Partial<Record<LocaleName, Readonly<OrihonLocale>>>
): void {
  Object.assign(packCache, packs);
}

/** Ensure non-English built-ins are loaded (no-op if already registered). */
export function ensureLocalePacks(): Promise<void> {
  if (packCache.ru) return Promise.resolve();
  if (!packsLoading) {
    packsLoading = import("./locale-packs.js")
      .then((mod) => {
        registerLocalePacks(mod.localePacks);
      })
      .catch(() => {
        packsLoading = null;
      });
  }
  return packsLoading ?? Promise.resolve();
}

function packedOrFallback(name: LocaleName): Readonly<OrihonLocale> {
  const hit = packCache[name];
  if (hit) return hit;
  if (name !== "en") void ensureLocalePacks();
  // Until packs resolve, keep language/rtl correct with English strings.
  return { ...enLocale, language: name, rtl: name === "ar" };
}

export const locales: Readonly<Record<LocaleName, Readonly<OrihonLocale>>> = Object.freeze({
  get en() { return enLocale; },
  get ru() { return packedOrFallback("ru"); },
  get ar() { return packedOrFallback("ar"); },
  get tr() { return packedOrFallback("tr"); },
  get zh() { return packedOrFallback("zh"); },
  get de() { return packedOrFallback("de"); },
  get fr() { return packedOrFallback("fr"); },
  get da() { return packedOrFallback("da"); },
  get hi() { return packedOrFallback("hi"); }
}) as Readonly<Record<LocaleName, Readonly<OrihonLocale>>>;

export function resolveLocale(input: LocaleInput = "en"): OrihonLocale {
  if (typeof input === "string") {
    return { ...packedOrFallback(input) };
  }
  return { ...enLocale, ...input };
}
