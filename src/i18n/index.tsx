// Localization runtime: French by default, English fully supported.
//
// * React code calls `useI18n()` — components re-render the moment the language setting changes.
// * Non-React code (formatters, the AutomationEngine) calls `t()` / `getLang()`, which follow the
//   active language set by the DataHub whenever settings arrive.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LANG, LANGUAGES, TRANSLATIONS, type Lang, type TranslationKey } from "./translations";

export { DEFAULT_LANG, LANGUAGES, type Lang, type TranslationKey };

export type Params = Record<string, string | number>;
export type Translate = (key: TranslationKey, params?: Params) => string;

let activeLang: Lang = DEFAULT_LANG;

export function normalizeLang(value: unknown): Lang {
  return value === "en" ? "en" : DEFAULT_LANG;
}

export function setActiveLang(lang: Lang): void {
  activeLang = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return activeLang;
}

export function localeOf(lang: Lang): string {
  return lang === "en" ? "en-US" : "fr-FR";
}

/** BCP 47 locale of the active language, for `Intl` and `toLocale*String`. */
export function getLocale(): string {
  return localeOf(activeLang);
}

export function translate(lang: Lang, key: TranslationKey, params?: Params): string {
  const template = TRANSLATIONS[lang][key] ?? TRANSLATIONS.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translate in the active language (non-React call sites). */
export function t(key: TranslationKey, params?: Params): string {
  return translate(activeLang, key, params);
}

/** Look up a key built at runtime (`widget.<id>.name`, `tier.<key>`); `fallback` when unknown. */
export function translateDynamic(lang: Lang, key: string, fallback: string, params?: Params): string {
  return key in TRANSLATIONS.en ? translate(lang, key as TranslationKey, params) : fallback;
}

export interface I18n {
  lang: Lang;
  locale: string;
  t: Translate;
  /** Dynamic-key lookup with a fallback. */
  td: (key: string, fallback: string, params?: Params) => string;
}

function makeI18n(lang: Lang): I18n {
  return {
    lang,
    locale: localeOf(lang),
    t: (key, params) => translate(lang, key, params),
    td: (key, fallback, params) => translateDynamic(lang, key, fallback, params),
  };
}

const I18nContext = createContext<I18n>(makeI18n(DEFAULT_LANG));

export function I18nProvider(props: { lang: Lang; children: ReactNode }) {
  // Formatters read the active language during this very render pass.
  setActiveLang(props.lang);
  const value = useMemo(() => makeI18n(props.lang), [props.lang]);
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
