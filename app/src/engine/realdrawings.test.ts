/**
 * Conventions of real drawings from French / Moroccan (and Spanish)
 * practices: French title blocks and view names, centimetre and metre
 * notation, type legends instead of schedule tables, fill patterns, door
 * swings drawn as chains of straight lines, tags with leader lines.
 */
import { jsPDF } from "jspdf";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyTypeFromText, detectFloor } from "./classify";
import { extractVectorGeometry, polylineArcs } from "./geometry";
import { hatchSegments } from "./hatch";
import { useNodePlatform } from "./node/platform";
import { runOnBytes } from "./runner";
import { parseLegendSize } from "./schedules";
import { parseTag, tagClass } from "./tags";
import { Segment, emptyGeometry } from "./types";
import { findExpressions, parseSize } from "./units";

beforeAll(() => {
  useNodePlatform();
});

describe("dimension notation", () => {
  const values = (text: string, unit: string) => findExpressions(text, unit).map((e) => e.dim?.valueMm ?? null);

  it("reads centimetres written with a decimal (340.0) on centimetre drawings", () => {
    expect(values("340.0", "cm")).toEqual([3400]);
    expect(values("81.4", "cm")).toEqual([814]);
    expect(values("340.0", "mm")).toEqual([]);
  });

  it("reads metres with a point or a comma on metre drawings", () => {
    expect(values("3.45", "m")).toEqual([3450]);
    expect(values("0,90", "m")).toEqual([900]);
    expect(values("340.0", "m")).toEqual([]); // not a building dimension in metres
    expect(values("3,450", "m")).toEqual([]); // a thousands separator
  });

  it("reads the sizes written in type legends", () => {
    expect(parseSize("260 x 130 cm", "mm")!.map((d) => d.valueMm)).toEqual([2600, 1300]);
    expect(parseLegendSize("90/210", "cm")!.map((d) => d.value_mm)).toEqual([900, 2100]);
    expect(parseLegendSize("L=90 H=210", "cm")!.map((d) => d.value_mm)).toEqual([900, 2100]);
    expect(parseLegendSize("0,90 x 2,10", "m")!.map((d) => d.value_mm)).toEqual([900, 2100]);
    expect(parseLegendSize("Nombre : 2", "cm")).toBeNull();
  });
});

describe("tags", () => {
  it("knows window / door type prefixes and French and Spanish ones", () => {
    expect(parseTag("WT19")?.[1]).toBe("WT19");
    expect(parseTag("WT 16")?.[1]).toBe("WT16");
    expect(parseTag("PF2")?.[1]).toBe("PF2");
    expect(tagClass("WT")).toBe("window");
    expect(tagClass("F")).toBe("window");
    expect(tagClass("P")).toBe("door");
    expect(tagClass("V")).toBe("window");
  });

  it("reads GD as a garde-corps (railing) on French drawings, a garage door elsewhere", () => {
    expect(tagClass("GD", "fr")).toBe("railing");
    expect(tagClass("GD", "en")).toBe("garage_door");
    expect(tagClass("GD")).toBe("garage_door");
  });
});

describe("view names and floors", () => {
  it("classifies French and Spanish view titles", () => {
    expect(classifyTypeFromText("PLAN REZ DE CHAUSSEE")).toBe("floor_plan");
    expect(classifyTypeFromText("REPERAGE ALU")).toBe("floor_plan");
    expect(classifyTypeFromText("PLANTA BAJA")).toBe("floor_plan");
    expect(classifyTypeFromText("FAÇADE PRINCIPALE")).toBe("elevation");
    expect(classifyTypeFromText("FACADE ARRIERE")).toBe("elevation");
    expect(classifyTypeFromText("COUPE A-A")).toBe("section");
    expect(classifyTypeFromText("PLAN DE MASSE")).toBe("site_plan");
    expect(classifyTypeFromText("PLAN DE SITUATION")).toBe("site_plan");
    expect(classifyTypeFromText("TABLEAU DES MENUISERIES")).toBe("opening_schedule");
    expect(classifyTypeFromText("CUADRO DE CARPINTERÍA")).toBe("opening_schedule");
  });

  it("names the floor from French and Spanish titles", () => {
    expect(detectFloor(["PLAN SOUS-SOL"])).toBe("Basement");
    expect(detectFloor(["PLAN REZ DE CHAUSSEE"])).toBe("Ground Floor");
    expect(detectFloor(["PLAN RDC"])).toBe("Ground Floor");
    expect(detectFloor(["PLAN 1er ÉTAGE"])).toBe("First Floor");
    expect(detectFloor(["PLAN ETAGE"])).toBe("Upper Floor");
    expect(detectFloor(["PLAN TERRASSE"])).toBe("Roof");
    expect(detectFloor(["PLANTA BAJA"])).toBe("Ground Floor");
  });
});

describe("geometry", () => {
  it("treats a fill pattern as a pattern, and the lines of a window as a window", () => {
    const brick = Array.from({ length: 20 }, (_, i) => new Segment(100, 200 + 4.25 * i, 105.7, 200 + 4.25 * i, 0.5));
    const window = [0, 1.5, 3, 4.5].map((dy) => new Segment(300, 400 + dy, 360, 400 + dy, 0.3));
    const hatch = hatchSegments([...brick, ...window]);
    expect(brick.every((s) => hatch.has(s))).toBe(true);
    expect(window.some((s) => hatch.has(s))).toBe(false);
  });

  it("turns a door swing drawn as short straight lines into an arc", () => {
    const g = emptyGeometry();
    const r = 45;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const a0 = (Math.PI / 2) * (i / steps);
      const a1 = (Math.PI / 2) * ((i + 1) / steps);
      g.segments.push(new Segment(200 + r * Math.cos(a0), 300 + r * Math.sin(a0), 200 + r * Math.cos(a1), 300 + r * Math.sin(a1)));
    }
    // a straight dashed line of short pieces is not an arc
    for (let i = 0; i < 8; i++) g.segments.push(new Segment(400 + 5 * i, 100, 405 + 5 * i, 100));
    polylineArcs(g);
    expect(g.arcs).toHaveLength(1);
    expect(g.arcs[0].r).toBeCloseTo(45, 0);
    expect(g.arcs[0].sweepDeg).toBeCloseTo(90, -1);
    expect(extractVectorGeometry([]).arcs).toHaveLength(0);
  });
});

describe("a French opening plan with a type legend", () => {
  it("reads the types, sizes and counts from the legend and the tags on the plan", async () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: [1684, 1190] });
    doc.setFontSize(10);
    // the plan: a room with two windows and a door, tags next to them
    doc.setLineWidth(3);
    doc.rect(100, 150, 600, 400);
    doc.setLineWidth(0.5);
    doc.text("WT19", 220, 140);
    doc.text("WT19", 470, 140);
    doc.text("DR01", 380, 570);
    doc.text("GD01", 600, 300);
    for (const [x, t] of [
      [200, "130.0"],
      [300, "340.0"],
      [420, "130.0"],
      [520, "281.4"],
      [150, "350.0"],
      [610, "585.0"],
    ] as const)
      doc.text(t, Number(x), 600);
    doc.setFontSize(16);
    doc.text("REPERAGE ALU", 100, 680);
    // the type legend
    doc.setFontSize(27);
    doc.text("WT 19", 900, 400);
    doc.text("DR 01", 1150, 400);
    doc.text("GD 01", 900, 700);
    doc.setFontSize(14);
    doc.text("130 x 130 cm", 900, 425);
    doc.text("Nombre : 2", 900, 450);
    doc.text("280 x 250 cm", 1150, 425);
    doc.text("Nombre : 1", 1150, 450);
    doc.text("Nombre : 1", 900, 725);
    // French title block
    doc.setFontSize(10);
    const tb: [string, string][] = [
      ["Projet", "MAT Rabat"],
      ["Titre", "Reperage portes et fenetres"],
      ["Numéro", "A001"],
      ["Echelle", "1:50"],
      ["Date", "24.06.22"],
    ];
    tb.forEach(([k, v], i) => {
      doc.text(k, 1420, 900 + 22 * i);
      doc.text(v, 1500, 900 + 22 * i);
    });
    doc.text("Toutes les dimensions sont exprimées en centimètres.", 1420, 870);
    doc.rect(1410, 850, 260, 330);

    const res = await runOnBytes([["reperage.pdf", new Uint8Array(doc.output("arraybuffer"))]]);
    const byTag = new Map(res.records.filter((r) => r.tag).map((r) => [r.tag_key, r]));
    const wt19 = byTag.get("WT19")!;
    expect(wt19.type).toBe("window");
    expect(wt19.width?.value).toBe(1300);
    expect(wt19.height?.value).toBe(1300);
    expect(wt19.quantity).toBe(2);
    expect(wt19.tag).toBe("WT19"); // as written on the plan
    const dr01 = byTag.get("D1")!; // DR is the door prefix
    expect([dr01.width?.value, dr01.height?.value, dr01.quantity]).toEqual([2800, 2500, 1]);
    expect(byTag.get("GD1")!.type).toBe("railing"); // garde-corps
    expect(res.pages[0].cls.defaultUnit).toBe("cm");
    expect(res.pages[0].cls.pageType).toBe("floor_plan");
  }, 60_000);
});
