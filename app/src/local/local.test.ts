/**
 * The on-device app layer end to end: upload a drawing set, extract, review,
 * re-extract without losing edits, export PDFs, delete - all without a server.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { installNodeEngine } from "./testing/nodeEngine";
import { localApi, uploadFiles } from "./api";
import { platform } from "../engine/platform";
import { pdfSafe } from "./report";

const FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/residential_plans.pdf");
// set PM_REPORT_OUT=<dir> to keep the exported PDFs for a visual check
const OUT = process.env.PM_REPORT_OUT;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function waitForJob(pid: string, timeoutMs = 240_000): Promise<Json> {
  const t0 = Date.now();
  for (;;) {
    const [job] = (await localApi("GET", `/api/projects/${pid}/jobs`)) as Json[];
    if (job && (job.status === "succeeded" || job.status === "failed")) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error("processing timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number; images: number }> {
  const { pdfjs } = platform();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  let text = "";
  let images = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it: { str?: string }) => it.str ?? "").join(" ") + "\n";
    const ol = await page.getOperatorList();
    images += ol.fnArray.filter((f: number) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintJpegXObject).length;
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { text, pages, images };
}

async function exportPdf(pid: string, body: Json): Promise<Uint8Array> {
  const res = (await localApi("POST", `/api/projects/${pid}/export/pdf`, body)) as { blob: Blob; filename: string };
  expect(res.filename).toMatch(/_measurement_schedule_(summary|detailed)\.pdf$/);
  const bytes = new Uint8Array(await res.blob.arrayBuffer());
  if (OUT) writeFileSync(path.join(OUT, res.filename), bytes);
  return bytes;
}

describe("on-device app layer", () => {
  let pid = "";
  let openings: Json[] = [];

  beforeAll(async () => {
    installNodeEngine();
    const p = (await localApi("POST", "/api/projects", { name: "Harbour Street" })) as Json;
    pid = p.id;
    const file = new File([readFileSync(FIXTURE)], "Residential_Plans.pdf", { type: "application/pdf" });
    const up = (await uploadFiles(pid, [file])) as Json;
    expect(up.errors).toEqual([]);
    expect(up.job).toBeTruthy();
    const job = await waitForJob(pid);
    expect(job.error).toBeNull();
    expect(job.status).toBe("succeeded");
    openings = (await localApi("GET", `/api/projects/${pid}/openings`)) as Json[];
  }, 300_000);

  it("extracts openings and renders every page", async () => {
    expect(openings.length).toBeGreaterThan(10);
    const pages = (await localApi("GET", `/api/projects/${pid}/pages`)) as Json[];
    expect(pages.length).toBe(10);
    expect(pages.every((p) => p.image_url || p.has_image || p.image_width)).toBe(true);
    // measurements are never invented: every value carries its drawing source
    for (const o of openings) {
      for (const m of [o.width, o.height]) if (m && m.value !== null) expect(m.source).toBeTruthy();
    }
  });

  it("rejects a duplicate upload", async () => {
    const file = new File([readFileSync(FIXTURE)], "copy.pdf", { type: "application/pdf" });
    await expect(uploadFiles(pid, [file])).rejects.toMatchObject({ status: 422 });
  });

  it("keeps user edits through a re-extraction and records them in the audit trail", async () => {
    const target = openings.find((o) => o.tag && o.width && o.width.value)!;
    const edited = (await localApi("PATCH", `/api/projects/${pid}/openings/${target.id}`, { changes: { width: { text: "1234" }, notes: "Checked on site – ok ✓" }, version: target.version })) as Json;
    expect(edited.width.value).toBe(1234);
    expect(edited.width.source).toBe("user");
    await expect(localApi("PATCH", `/api/projects/${pid}/openings/${target.id}`, { changes: { width: { text: "1000" } }, version: target.version })).rejects.toMatchObject({ status: 409 });
    const verified = (await localApi("POST", `/api/projects/${pid}/openings/${target.id}/verify`, { verified: true })) as Json;
    expect(verified.verification.verified).toBe(true);

    await localApi("POST", `/api/projects/${pid}/process`);
    const job = await waitForJob(pid);
    expect(job.status).toBe("succeeded");
    const after = (await localApi("GET", `/api/projects/${pid}/openings`)) as Json[];
    const same = after.find((o) => o.id === target.id)!;
    expect(same.width.value).toBe(1234);
    expect(same.verification.verified).toBe(true);
    expect(after.length).toBe(openings.length);

    const trail = (await localApi("GET", `/api/projects/${pid}/openings/${target.id}/audit`)) as Json[];
    expect(trail.map((a) => a.action)).toEqual(expect.arrayContaining(["edit", "verify"]));
  }, 300_000);

  it("exports summary and detailed PDFs from the reviewed data", async () => {
    const sched = (await localApi("GET", `/api/projects/${pid}/schedule?unit=mm`)) as Json;
    const summary = await pdfText(await exportPdf(pid, { kind: "summary", info: { prepared_by: "Test Reviewer", notes: "Line one\nLine two" } }));
    expect(summary.text).toContain("Opening Measurement Schedule");
    expect(summary.text).toContain("Test Reviewer");
    expect(summary.text).toContain("1234 mm");
    expect(summary.text).toContain(`${sched.total_openings}`);
    expect(summary.text).toMatch(/Page 1 of \d+/);
    expect(summary.images).toBe(0);

    const detailed = await pdfText(await exportPdf(pid, { kind: "detailed", page_size: "A3", orientation: "landscape", unit: "ft_in" }));
    expect(detailed.text).toContain("Source detail for each opening");
    expect(detailed.text).toContain("entered/confirmed by user");
    expect(detailed.text).toContain("Checked on site – ok v");
    expect(detailed.images).toBeGreaterThan(5);
    expect(detailed.pages).toBeGreaterThan(summary.pages);

    const audit = (await localApi("GET", `/api/projects/${pid}/audit`)) as Json[];
    expect(audit.filter((a) => a.action === "export_pdf").length).toBe(2);
  }, 120_000);

  it("maps text onto the characters the PDF fonts support", () => {
    expect(pdfSafe("3′-0″ ≈ 915 mm – café")).toBe("3'-0\" ~ 915 mm – café");
    expect(pdfSafe("房间 A")).toBe("?? A");
  });

  it("deletes a project with all its data", async () => {
    await localApi("DELETE", `/api/projects/${pid}`);
    const list = (await localApi("GET", "/api/projects")) as Json[];
    expect(list.find((p) => p.id === pid)).toBeUndefined();
    await expect(localApi("GET", `/api/projects/${pid}/openings`)).rejects.toMatchObject({ status: 404 });
  });
});
