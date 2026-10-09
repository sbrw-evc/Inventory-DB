import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ru } from './ru';
import { ruFeatures } from './ruFeatures';

/**
 * Tiny i18n: English strings are the keys; other languages map them to translations.
 * Missing translations fall back to English. `{name}` placeholders are interpolated.
 */
export type Lang = 'en' | 'ru';
export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
];

const DICTS: Record<Lang, Record<string, string>> = { en, ru: { ...ruFeatures, ...ru } };
// Shared with the NetBox pages, which read the same key.
const KEY = 'lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* ignore */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let lang: Lang = initialLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((l) => l());
}

export function translate(l: Lang, key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[l][key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Non-hook translation using the current language (for toasts and helpers). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(lang, key, vars);
}

export type TFn = typeof t;

/** Subscribes the component to language changes and returns `t`. */
export function useT(): TFn {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
    () => lang,
  );
  return (key, vars) => translate(current, key, vars);
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
    () => lang,
  );
}
