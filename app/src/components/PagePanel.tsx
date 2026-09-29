import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { PageInfo } from "../api/types";
import { qk, useSystem } from "../hooks/data";
import { useToast } from "./ui";
import { t, tx } from "../i18n";

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
    toast(t("Re-extraction queued – follow progress on Upload Plans"));
    setDirty(false);
  };

  const applyManual = () => {
    const v = manual.trim();
    const text = /^\d+(\.\d+)?$/.test(v) ? `1:${v}` : v;
    patch({ scale_override: text }, t("Manual scale {s} saved", { s: text }));
  };

  return (
    <div className="tab-body page-panel">
      <h4>
        {t("Page {n}", { n: page.page })} · {page.sheet_number ?? t("no sheet number")}
      </h4>
      <div className="small muted">
        {page.document} · {t("page {n}", { n: page.page_in_document })}
        {page.sheet_title ? ` · ${page.sheet_title}` : ""}
      </div>
      <dl className="kv">
        <dt>{t("Page type")}</dt>
        <dd>
          {canEdit ? (
            <select
              value={page.page_type_override ?? page.page_type ?? "other"}
              onChange={(e) => patch({ page_type_override: e.target.value }, t("Page type updated"))}
              aria-label={t("Page type")}
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
            {page.page_type_override ? t("Set by you") : t("Detected") + (page.classification_confidence !== null ? ` · ${Math.round((page.classification_confidence ?? 0) * 100)}%` : "")}
            {page.page_type_override && canEdit && (
              <>
                {" · "}
                <button className="linkish" onClick={() => patch({ clear_page_type: true }, t("Using detected page type"))}>
                  {t("use detected ({type})", { type: system.data?.page_types[page.page_type_detected ?? ""] ?? page.page_type_detected ?? "" })}
                </button>
              </>
            )}
          </div>
        </dd>
        <dt>{t("Floor")}</dt>
        <dd>{page.floor ?? "—"}</dd>
        <dt>{t("Detected scale")}</dt>
        <dd>
          {primary?.text ? (
            <>
              <b>{primary.text}</b> <span className="small muted">({tx(primary.source)}, {Math.round((primary.confidence ?? 0) * 100)}%)</span>
              {primary.notes?.map((n, i) => (
                <div key={i} className="small muted">
                  {tx(n)}
                </div>
              ))}
            </>
          ) : (
            <span className="muted">{primary?.not_to_scale ? t("Not to scale (NTS)") : t("None detected")}</span>
          )}
          {page.scale_override && canEdit && (
            <div>
              <button className="btn btn-sm" onClick={() => patch({ scale_override: "" }, t("Using detected scale"))}>
                {t("Use detected scale")}
              </button>
            </div>
          )}
        </dd>
        <dt>{t("Manual scale")}</dt>
        <dd>
          {canEdit ? (
            <div className="row gap scale-input">
              <span>1 :</span>
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("{a} or {b}", { a: "100", b: `1/4" = 1'-0"` })} aria-label={t("Manual scale")} />
              <button className="btn btn-sm" onClick={applyManual} disabled={!manual.trim()}>
                {t("Apply")}
              </button>
            </div>
          ) : (
            page.scale_override?.text ?? "—"
          )}
          <div className="small muted">{t("Scale is only used when no explicit dimension exists; such values are marked “inferred”.")}</div>
        </dd>
        {page.quality?.kind && page.quality.kind !== "vector" && (
          <>
            <dt>{t("Source")}</dt>
            <dd>
              {t("Raster image")}
              {page.quality.effective_dpi ? ` · ~${Math.round(page.quality.effective_dpi)} dpi` : ""}
              {page.quality.poor && <div className="error-text small">{t("Low quality: {reasons}", { reasons: (page.quality.reasons ?? []).map((r) => tx(r)).join(", ") })}</div>}
            </dd>
          </>
        )}
      </dl>
      {dirty && canEdit && (
        <div className="banner banner-info">
          {t("Changes apply on the next extraction.")}{" "}
          <button className="btn btn-sm btn-primary" onClick={reextract}>
            {t("Re-extract now")}
          </button>
        </div>
      )}
      <div className="section">
        <h4>{t("Why this page type")}</h4>
        <ul className="ev-list">
          {page.classification_signals.slice(0, 8).map((s, i) => (
            <li key={i} className="ev ev-info">
              <span className="small">
                {tx(s.detail)} <span className="muted">→ {system.data?.page_types[s.type] ?? s.type}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
