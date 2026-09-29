/**
 * French and Spanish cover everything the app shows: every interface text,
 * every placeholder, and every sentence the extraction engine produced on the
 * benchmark drawing sets.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JS helper shared with the command line
import { extractKeys } from "../../scripts/i18n-keys.mjs";
import { useNodePlatform } from "../engine/node/platform";
import { runOnBytes } from "../engine/runner";
import { FLAG_INFO } from "../engine/confidence";
import { STEPS } from "../engine/meta";
import { OPENING_TYPE_LABELS, PAGE_TYPE_LABELS } from "../engine/types";
import { _internals, hasTranslation, num, setLang, t, tp, tx } from "./index";

const LANGS = ["fr", "es"] as const;
const placeholders = (s: string) => [...s.matchAll(/\{~?(\w+)\}/g)].map((m) => m[1]).sort();

// texts passed to t() through variables
const DYNAMIC_KEYS = [
  ...["Type", "Tag", "Size", "Page", "Floor"],
  ...["Upload", "Demo", "Re-extraction"],
  ...["succeeded", "failed", "running", "queued", "uploaded", "rendered", "processed"],
  ...["dimension on drawing", "size callout", "schedule", "inferred from drawing scale", "entered/confirmed by user"],
  ...["plan instances", "schedule only", "reference only", "elevation references", "user", "none"],
];

afterEach(() => setLang("en", false));

describe("interface text", () => {
  const keys: string[] = [...extractKeys(), ...DYNAMIC_KEYS];

  it("finds the interface texts in the code", () => {
    expect(keys.length).toBeGreaterThan(400);
  });

  for (const lang of LANGS) {
    it(`has a ${lang} translation for every text`, () => {
      const missing = keys.filter((k) => _internals.DICTS[lang][k] === undefined);
      expect(missing).toEqual([]);
    });

    it(`keeps the placeholders in ${lang}`, () => {
      const bad = Object.entries(_internals.DICTS[lang]).filter(([en, tr]) => placeholders(en).join() !== placeholders(tr).join());
      expect(bad).toEqual([]);
    });
  }

  it("has no French or Spanish entries that the code no longer uses", () => {
    const labels = new Set([
      ...Object.values(OPENING_TYPE_LABELS),
      ...Object.values(OPENING_TYPE_LABELS).map((l) => l.toLowerCase()),
      ...Object.values(PAGE_TYPE_LABELS),
      ...Object.values(FLAG_INFO).map(([, l]) => l),
      ...STEPS.map(([, l]) => l),
    ]);
    const known = new Set([...keys, ...labels]);
    for (const lang of LANGS) {
      const unused = Object.keys(_internals.DICTS[lang]).filter((k) => !known.has(k) && !hasTemplateUse(k));
      expect(unused).toEqual([]);
    }
  });
});

// words used inside engine sentences (field names, "Drawing", "Not analysed", …)
function hasTemplateUse(k: string): boolean {
  return ["width", "height", "type", "tag", "quantity", "floor", "room", "notes", "page index", "Drawing", "Not analysed", "Doors", "Windows", "Sliding doors", "Width", "Height", "manual", "calibrated"].includes(k);
}

describe("engine and storage-layer sentences", () => {
  it("has matching placeholders in every template", () => {
    const bad = _internals.MESSAGES.filter(([en, fr, es]) => placeholders(en).join() !== placeholders(fr).join() || placeholders(en).join() !== placeholders(es).join());
    expect(bad).toEqual([]);
  });

  it("translates the engine's labels", () => {
    const labels = [
      ...Object.values(OPENING_TYPE_LABELS),
      ...Object.values(PAGE_TYPE_LABELS),
      ...Object.values(FLAG_INFO).map(([, l]) => l),
      ...STEPS.map(([, l]) => l),
    ];
    for (const lang of LANGS) expect(labels.filter((l) => !hasTranslation(l, lang))).toEqual([]);
  });

  describe("on the benchmark drawing sets", () => {
    const sentences = new Map<string, Set<string>>();
    const add = (kind: string, s: unknown) => {
      if (typeof s !== "string" || !s) return;
      if (!sentences.has(kind)) sentences.set(kind, new Set());
      sentences.get(kind)!.add(s);
    };

    beforeAll(async () => {
      useNodePlatform();
      const dir = path.resolve(__dirname, "../../benchmark/sets");
      const sets = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort().slice(0, 12);
      for (const f of sets) {
        const res = await runOnBytes([[f, new Uint8Array(readFileSync(path.join(dir, f)))]], undefined, null, undefined, (_s, _f, msg) => add("progress", msg));
        for (const r of res.records) {
          for (const fl of r.flags) add("flag", fl.message);
          for (const e of r.evidence) (add("evidence", e.label), add("evidence", e.detail));
          for (const m of [r.width, r.height]) for (const e of m?.evidence ?? []) (add("evidence", e.label), add("evidence", e.detail));
        }
        for (const p of res.pages) {
          for (const s of p.cls.signals) add("signal", s.detail);
          for (const v of p.views) for (const n of v.scale.notes) add("scale", n);
        }
      }
    }, 120_000);

    for (const lang of LANGS) {
      it(`covers every sentence in ${lang}`, () => {
        expect(sentences.size).toBeGreaterThan(3);
        const missing: string[] = [];
        for (const [kind, set] of sentences) for (const s of set) if (!hasTranslation(s, lang)) missing.push(`${kind}: ${s}`);
        expect(missing).toEqual([]);
      });
    }
  });
});

describe("translation behaviour", () => {
  it("translates sentences with values, keeping what is quoted from the drawing", () => {
    setLang("fr", false);
    expect(tx("Tag W-03 detected (enclosed tag symbol)")).toBe("Repère W-03 détecté (symbole de repère encadré)");
    expect(tx("Height 600 mm inferred from drawing scale - no explicit dimension found")).toBe("Hauteur 600 mm déduite de l'échelle du dessin – aucune cote explicite");
    expect(tx("Page 3 is a low-quality scan: blurry, low contrast")).toBe("Page 3 est un scan de mauvaise qualité : floue, faible contraste");
    expect(tx("Opening detected (Sliding door)")).toBe("Ouverture détectée (Porte coulissante)");
    setLang("es", false);
    expect(tx("Confirmed by Window Schedule: 1200")).toBe("Confirmado por Window Schedule: 1200");
    expect(tx("User changed width from 1200 mm to 1234 mm")).toBe("Cambio del usuario – ancho: 1200 mm → 1234 mm");
    expect(tx("something the app never says")).toBe("something the app never says");
  });

  it("uses each language's plural rules and decimal comma", () => {
    setLang("fr", false);
    expect(tp(0, "{n} opening", "{n} openings")).toBe("0 ouverture");
    expect(tp(2, "{n} opening", "{n} openings")).toBe("2 ouvertures");
    expect(num("2.1 m")).toBe("2,1 m");
    setLang("es", false);
    expect(tp(0, "{n} opening", "{n} openings")).toBe("0 vanos");
    expect(tp(1, "{n} opening", "{n} openings")).toBe("1 vano");
    setLang("en", false);
    expect(t("Needs review")).toBe("Needs review");
    expect(num("2.1 m")).toBe("2.1 m");
  });
});

describe("conflict messages", () => {
  it("translates the joining word between the sources", () => {
    setLang("fr", false);
    expect(tx("Height conflict - Window Schedule: 1200 vs East Elevation A-202, West Elevation A-202: 1500")).toBe(
      "Conflit de hauteur – Window Schedule: 1200 contre East Elevation A-202, West Elevation A-202: 1500",
    );
    setLang("es", false);
    expect(tx("Width conflict - Door Schedule: 900 vs North Elevation A-201: 1000 vs Enlarged Plan A-501: 950")).toBe(
      "Conflicto de ancho: Door Schedule: 900 frente a North Elevation A-201: 1000 frente a Enlarged Plan A-501: 950",
    );
  });
});
