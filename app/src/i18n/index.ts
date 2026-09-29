/**
 * Languages: English, French and Spanish.
 *
 * Interface text is written in English in the code and translated with t()
 * (the English text is the key, so a missing translation shows English).
 * Sentences produced by the extraction engine and the app's storage layer are
 * stored in English and translated when shown, with tx(): exact labels from the
 * dictionaries, and templates with placeholders for sentences that contain
 * values (see messages.ts).
 */
import { useSyncExternalStore } from "react";
import es from "./es";
import fr from "./fr";
import { MESSAGES } from "./messages";

export type Lang = "en" | "fr" | "es";
type Params = Record<string, string | number>;

export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
];

const DICTS: Record<Lang, Record<string, string>> = { en: {}, fr, es };
const STORAGE_KEY = "pm.lang";

function isLang(v: unknown): v is Lang {
  return v === "en" || v === "fr" || v === "es";
}

/** Saved choice, else the device language, else English. */
function detect(): Lang {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // storage unavailable
  }
  const nav = typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language ?? "") : "";
  const code = nav.slice(0, 2).toLowerCase();
  return isLang(code) ? code : "en";
}

let current: Lang = typeof window === "undefined" ? "en" : detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang, persist = true): void {
  if (!isLang(lang) || lang === current) return;
  current = lang;
  if (persist) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, lang);
    } catch {
      // storage unavailable
    }
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  for (const f of listeners) f();
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The current language; components using it re-render when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** BCP 47 locale for dates and numbers. */
export function locale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
  if (nav.toLowerCase().startsWith(current)) return nav;
  return { en: "en-US", fr: "fr-FR", es: "es-ES" }[current];
}

function fill(s: string, p?: Params): string {
  return p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m)) : s;
}

/** Translate interface text. `{name}` placeholders are filled from `p`. */
export function t(s: string, p?: Params): string {
  return fill(DICTS[current][s] ?? s, p);
}

/** Pick the singular or plural form for n (French treats 0 as singular). */
export function tp(n: number, one: string, other: string, p?: Params): string {
  const singular = current === "fr" ? n === 0 || n === 1 : n === 1;
  return t(singular ? one : other, { n, ...p });
}

/** Decimal comma for French and Spanish. */
export function num(s: string): string {
  return current === "en" ? s : s.replace(/(\d)\.(\d)/g, "$1,$2");
}

// ---------------------------------------------------------------------------
// engine and storage-layer sentences
// ---------------------------------------------------------------------------

interface Template {
  re: RegExp;
  out: Record<Exclude<Lang, "en">, string>;
  literal: number;
}

let templates: Template[] | null = null;
const cache: Record<Exclude<Lang, "en">, Map<string, string>> = { fr: new Map(), es: new Map() };

function compile(): Template[] {
  const out: Template[] = [];
  for (const [en, fr, es] of MESSAGES) {
    let src = "";
    let literal = 0;
    let last = 0;
    for (const m of en.matchAll(/\{~?(\w+)\}/g)) {
      const lit = en.slice(last, m.index);
      src += lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + `(?<${m[1]}>.+?)`;
      literal += lit.length;
      last = m.index! + m[0].length;
    }
    const tail = en.slice(last);
    src += tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    literal += tail.length;
    out.push({ re: new RegExp(`^${src}$`, "s"), out: { fr, es }, literal });
  }
  // the most specific template wins
  return out.sort((a, b) => b.literal - a.literal);
}

/**
 * Translate a sentence produced in English by the engine or the storage layer.
 * Placeholders written {~name} in a template are translated too; values such
 * as tags, sheet numbers and dimension text are kept as written on the drawing.
 */
export function tx(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  if (current === "en" || !s) return s;
  const exact = DICTS[current][s];
  if (exact !== undefined) return exact;
  const lang = current;
  const hit = cache[lang].get(s);
  if (hit !== undefined) return hit;
  templates ??= compile();
  let out = s;
  for (const tpl of templates) {
    const m = tpl.re.exec(s);
    if (!m) continue;
    out = tpl.out[lang].replace(/\{(~?)(\w+)\}/g, (_all, tilde: string, k: string) => {
      const v = m.groups?.[k] ?? "";
      return tilde ? txPart(v) : v;
    });
    break;
  }
  if (cache[lang].size > 5000) cache[lang].clear();
  cache[lang].set(s, out);
  return out;
}

/** Whether a sentence is covered by the dictionaries or a template (tests). */
export function hasTranslation(s: string, lang: Exclude<Lang, "en">): boolean {
  if (DICTS[lang][s] !== undefined) return true;
  templates ??= compile();
  return templates.some((tpl) => tpl.re.test(s));
}

/** The dictionaries and templates themselves (tests). */
export const _internals = { DICTS, MESSAGES };

/** A translated placeholder value; lists ("blurry, low contrast") are translated item by item. */
function txPart(v: string): string {
  const whole = tx(v);
  if (whole !== v || !v.includes(", ")) return whole;
  return v
    .split(", ")
    .map((x) => tx(x))
    .join(", ");
}
