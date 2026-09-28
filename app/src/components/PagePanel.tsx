import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { PageInfo } from "../api/types";
import { qk, useSystem } from "../hooks/data";
import { useToast } from "./ui";

/** Page classification + drawing scale (detected vs manual) for the current page. */
export default function PagePanel({ projectId, page, canEdit }: { projectId: string; page: PageInfo; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const system = useSystem();
  const [manual, setManual] = useState("");
  const [dirty, setDirty] = useState(false);
  const primary = page.scale?.primary;

  useEffect(() => {
    const txt = page.scale_override?.text ?? "";
    setManual(txt.startsWith("1:") ? txt.slice(2) : txt);
  }, [page.id, page.scale_override?.text]);

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/api/projects/${projectId}/pages/${page.id}`, { method: "PATCH", body });
      qc.invalidateQueries({ queryKey: qk.pages(projectId) });
      setDirty(true);
      toast(msg);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const reextract = async () => {
    await api(`/api/projects/${projectId}/process`, { method: "POST" });
    qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
    toast("Re-extraction queued – follow progress on Upload Plans");
    setDirty(false);
  };

  const applyManual = () => {
    const v = manual.trim();
    const text = /^\d+(\.\d+)?$/.test(v) ? `1:${v}` : v;
    patch({ scale_override: text }, `Manual scale ${text} saved`);
  };

  return (
    <div className="tab-body page-panel">
      <h4>
        Page {page.page} · {page.sheet_number ?? "no sheet number"}
      </h4>
      <div className="small muted">
        {page.document} · page {page.page_in_document}
        {page.sheet_title ? ` · ${page.sheet_title}` : ""}
      </div>
      <dl className="kv">
        <dt>Page type</dt>
        <dd>
          {canEdit ? (
            <select
              value={page.page_type_override ?? page.page_type ?? "other"}
              onChange={(e) => patch({ page_type_override: e.target.value }, "Page type updated")}
              aria-label="Page type"
            >
              {Object.entries(system.data?.page_types ?? {}).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            page.page_type_label
          )}
          <div className="small muted">
            {page.page_type_override ? "Set by you" : `Detected${page.classification_confidence !== null ? ` · ${Math.round((page.classification_confidence ?? 0) * 100)}%` : ""}`}
            {page.page_type_override && canEdit && (
              <>
                {" · "}
                <button className="linkish" onClick={() => patch({ clear_page_type: true }, "Using detected page type")}>
                  use detected ({page.page_type_detected})
                </button>
              </>
            )}
          </div>
        </dd>
        <dt>Floor</dt>
        <dd>{page.floor ?? "—"}</dd>
        <dt>Detected scale</dt>
        <dd>
          {primary?.text ? (
            <>
              <b>{primary.text}</b> <span className="small muted">({primary.source}, {Math.round((primary.confidence ?? 0) * 100)}%)</span>
              {primary.notes?.map((n, i) => (
                <div key={i} className="small muted">
                  {n}
                </div>
              ))}
            </>
          ) : (
            <span className="muted">{primary?.not_to_scale ? "Not to scale (NTS)" : "None detected"}</span>
          )}
          {page.scale_override && canEdit && (
            <div>
              <button className="btn btn-sm" onClick={() => patch({ scale_override: "" }, "Using detected scale")}>
                Use detected scale
              </button>
            </div>
          )}
        </dd>
        <dt>Manual scale</dt>
        <dd>
          {canEdit ? (
            <div className="row gap scale-input">
              <span>1 :</span>
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={`100 or 1/4" = 1'-0"`} aria-label="Manual scale" />
              <button className="btn btn-sm" onClick={applyManual} disabled={!manual.trim()}>
                Apply
              </button>
            </div>
          ) : (
            page.scale_override?.text ?? "—"
          )}
          <div className="small muted">Scale is only used when no explicit dimension exists; such values are marked “inferred”.</div>
        </dd>
        {page.quality?.kind && page.quality.kind !== "vector" && (
          <>
            <dt>Source</dt>
            <dd>
              Raster image{page.quality.effective_dpi ? ` · ~${Math.round(page.quality.effective_dpi)} dpi` : ""}
              {page.quality.poor && <div className="error-text small">Low quality: {page.quality.reasons?.join(", ")}</div>}
            </dd>
          </>
        )}
      </dl>
      {dirty && canEdit && (
        <div className="banner banner-info">
          Changes apply on the next extraction.{" "}
          <button className="btn btn-sm btn-primary" onClick={reextract}>
            Re-extract now
          </button>
        </div>
      )}
      <div className="section">
        <h4>Why this page type</h4>
        <ul className="ev-list">
          {page.classification_signals.slice(0, 8).map((s, i) => (
            <li key={i} className="ev ev-info">
              <span className="small">
                {s.detail} <span className="muted">→ {system.data?.page_types[s.type] ?? s.type}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
