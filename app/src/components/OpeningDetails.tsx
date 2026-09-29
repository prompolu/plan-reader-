import { useEffect, useState } from "react";
import { Bot, Check, CheckCircle2, Circle, Pencil, RotateCcw, Trash2, User as UserIcon, XCircle } from "lucide-react";
import type { BBox, DisplayUnit, Evidence, Measurement, Opening, PageInfo, Thresholds } from "../api/types";
import { useAudit, useOpeningMutation } from "../hooks/data";
import { formatLength, SOURCE_LABELS } from "../lib/units";
import { ConfidenceBadge, ConfidenceBar, FlagChip, StatusBadge, useToast } from "./ui";
import { locale, t, tx } from "../i18n";
import { PAGE_TYPE_LABELS } from "../engine/types";

export interface NavTarget {
  page_index: number;
  bbox: BBox | null;
  color?: string;
}

interface Props {
  projectId: string;
  opening: Opening;
  thresholds: Thresholds;
  unit: DisplayUnit;
  pages: PageInfo[];
  canEdit: boolean;
  onNavigate: (t: NavTarget) => void;
  onDeleted?: () => void;
  openingTypes: Record<string, string>;
}

type Tab = "details" | "evidence" | "history";

export default function OpeningDetails(p: Props) {
  const { opening: o } = p;
  const [tab, setTab] = useState<Tab>("details");
  const [editing, setEditing] = useState(false);
  const mut = useOpeningMutation(p.projectId);
  const toast = useToast();

  useEffect(() => {
    setEditing(false);
  }, [o.id]);

  const act = (args: Parameters<typeof mut.mutate>[0], ok: string) =>
    mut.mutate(args, { onSuccess: () => toast(ok), onError: (e) => toast((e as Error).message, "error") });

  const verified = o.verification.verified;
  return (
    <div className="details">
      <div className="details-head">
        <div>
          <div className="details-title">
            <span className="tag">{o.tag || t("Untagged")}</span>
            <span>{o.type_label}</span>
          </div>
          <div className="muted small">
            {o.ref} · {o.source === "user" ? t("added manually") : t("AI extracted")}
            {o.edited_fields.length > 0 && ` · ${t("edited: {fields}", { fields: o.edited_fields.map(fieldLabel).join(", ") })}`}
          </div>
        </div>
        <div className="details-badges">
          <StatusBadge o={o} />
          <ConfidenceBadge value={o.confidence.overall} t={p.thresholds} />
        </div>
      </div>
      {p.canEdit && (
        <div className="details-actions">
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            <Pencil size={14} /> {editing ? t("Cancel edit") : t("Edit")}
          </button>
          <button className={`btn ${verified ? "" : "btn-primary"}`} onClick={() => act({ id: o.id, path: "/verify", method: "POST", body: { verified: !verified } }, verified ? t("Verification removed") : t("{name} verified", { name: o.tag || o.ref }))}>
            {verified ? <RotateCcw size={14} /> : <Check size={14} />} {verified ? t("Unverify") : t("Verify")}
          </button>
          <button
            className="btn btn-danger-ghost"
            onClick={() => {
              if (confirm(t("Delete {name}? It is kept in the audit history and can be restored.", { name: o.tag || o.ref })))
                mut.mutate({ id: o.id, method: "DELETE" }, { onSuccess: () => { toast(t("Opening deleted")); p.onDeleted?.(); } });
            }}
          >
            <Trash2 size={14} /> {t("Delete")}
          </button>
        </div>
      )}
      {o.pending_ai && (
        <div className="banner banner-info">
          <b>{t("Re-extraction produced different values.")}</b> {t("Your edits were kept.")}
          <div className="small">
            {t("AI now says: width {w}, height {h}, qty {q}", {
              w: o.pending_ai.width ? formatLength(o.pending_ai.width.value, p.unit, o.pending_ai.width.original_text) : "—",
              h: o.pending_ai.height ? formatLength(o.pending_ai.height.value, p.unit, o.pending_ai.height.original_text) : "—",
              q: o.pending_ai.quantity ?? "—",
            })}
          </div>
          {p.canEdit && (
            <div className="row gap">
              <button className="btn btn-sm" onClick={() => act({ id: o.id, path: "/ai-update", method: "POST", body: { accept: true } }, t("AI values accepted"))}>
                {t("Accept AI values")}
              </button>
              <button className="btn btn-sm" onClick={() => act({ id: o.id, path: "/ai-update", method: "POST", body: { accept: false } }, t("Kept your values"))}>
                {t("Keep mine")}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="tabs">
        {(["details", "evidence", "history"] as Tab[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {k === "details" ? t("Details") : k === "evidence" ? t("Evidence") : t("History")}
          </button>
        ))}
      </div>
      {editing ? (
        <EditForm {...p} onDone={() => setEditing(false)} />
      ) : tab === "details" ? (
        <DetailsTab {...p} />
      ) : tab === "evidence" ? (
        <EvidenceTab {...p} />
      ) : (
        <HistoryTab projectId={p.projectId} openingId={o.id} />
      )}
    </div>
  );
}

function MeasurementBlock({ label, m, field, p }: { label: string; m: Measurement | null; field: "width" | "height"; p: Props }) {
  const mut = useOpeningMutation(p.projectId);
  const toast = useToast();
  const o = p.opening;
  if (!m)
    return (
      <div className="meas meas-missing">
        <div className="meas-label">{label}</div>
        <div className="meas-value">{t("Needs review")}</div>
        <div className="small muted">{field === "width" ? t("No reliable width found on the drawings. Nothing was assumed.") : t("No reliable height found on the drawings. Nothing was assumed.")}</div>
      </div>
    );
  if (m.status === "conflict")
    return (
      <div className="meas meas-conflict">
        <div className="meas-label">{label}</div>
        <div className="meas-value">{t("Conflict")}</div>
        <div className="small">{t("The sources disagree — choose the correct value or enter one:")}</div>
        {(m.candidates ?? []).map((c, i) => (
          <div key={i} className="cand">
            <button className="linkish" onClick={() => p.onNavigate({ page_index: c.page_index, bbox: c.bbox, color: "#dc2626" })}>
              {c.label}: <b>{formatLength(c.value, p.unit, c.original_text)}</b> <span className="muted">(“{c.original_text}”)</span>
            </button>
            {p.canEdit && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  mut.mutate({ id: o.id, path: "/resolve-conflict", method: "POST", body: { field, candidate_index: i } }, { onSuccess: () => toast(t("{field} set from {source}", { field: label, source: c.label })), onError: (e) => toast((e as Error).message, "error") })
                }
              >
                {t("Use this")}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  const cls = m.status === "inferred" ? "meas meas-inferred" : m.source === "user" ? "meas meas-user" : "meas";
  return (
    <div className={cls}>
      <div className="meas-label">{label}</div>
      <div className="meas-value">
        {formatLength(m.value, p.unit, m.original_text)}
        {p.unit !== "original" && m.original_text && m.source !== "user" && <span className="orig"> “{m.original_text}”</span>}
      </div>
      <div className="small">
        <span className={`src src-${m.source}`}>{SOURCE_LABELS[m.source] ?? m.source}</span>
        {m.status === "inferred" && <span className="badge badge-amber">{t("Inferred")}</span>}
        {m.sheet && m.page_index !== null && (
          <button className="linkish" onClick={() => p.onNavigate({ page_index: m.page_index!, bbox: m.bbox, color: "#1d4ed8" })}>
            {m.sheet}
          </button>
        )}
        <span className="muted"> · {Math.round((m.confidence ?? 0) * 100)}%</span>
      </div>
      {m.previous && <div className="small muted">{t("Previously: {v}", { v: m.previous.value !== null ? formatLength(m.previous.value, p.unit, m.previous.original_text) : tx(m.previous.status) })}</div>}
    </div>
  );
}

function DetailsTab(p: Props) {
  const o = p.opening;
  const thr = p.thresholds;
  const basis: Record<string, string> = {
    plan_instances: t("counted from floor plans"),
    elevation_references: t("counted from elevations"),
    schedule_only: t("schedule only – not located, not counted"),
    reference_only: t("shown only on details"),
    user: t("set by user"),
  };
  return (
    <div className="tab-body">
      <div className="meas-grid">
        <MeasurementBlock label={t("Width")} m={o.width} field="width" p={p} />
        <MeasurementBlock label={t("Height")} m={o.height} field="height" p={p} />
      </div>
      <dl className="kv">
        <dt>{t("Quantity")}</dt>
        <dd>
          <b>{o.quantity ?? "—"}</b> <span className="muted small">{basis[o.quantity_basis ?? ""] ?? o.quantity_basis}</span>
        </dd>
        <dt>{t("Source page")}</dt>
        <dd>
          {o.page_index !== null ? (
            <button className="linkish" onClick={() => p.onNavigate({ page_index: o.page_index!, bbox: o.bbox })}>
              {o.drawing_reference ?? t("Page")} · {t("page {n}", { n: o.page ?? "" })}
            </button>
          ) : (
            "—"
          )}
        </dd>
        <dt>{t("Floor")}</dt>
        <dd>{o.floor || "—"}</dd>
        <dt>{t("Room")}</dt>
        <dd>{o.room || "—"}</dd>
        {o.notes && (
          <>
            <dt>{t("Notes")}</dt>
            <dd className="pre">{o.notes}</dd>
          </>
        )}
      </dl>
      {o.flags.length > 0 && (
        <div className="section">
          <h4>{o.verification.verified ? t("Flags (acknowledged by verification)") : t("Needs attention")}</h4>
          {o.flags.map((f, i) => (
            <FlagChip key={i} f={f} />
          ))}
        </div>
      )}
      {o.instances.length > 0 && (
        <div className="section">
          <h4>{t("Located on plans ({n})", { n: o.instances.length })}</h4>
          <ul className="loc-list">
            {o.instances.map((inst, i) => (
              <li key={i}>
                <button className="linkish" onClick={() => p.onNavigate({ page_index: inst.page_index, bbox: inst.bbox })}>
                  {inst.sheet} · {[inst.floor, inst.room].filter(Boolean).join(" · ") || t("page {n}", { n: inst.page_index + 1 })}
                </button>
                {inst.width_text && <span className="muted small"> {t("dim")} “{inst.width_text}”</span>}
                {inst.geometry_missing && <span className="badge badge-amber">{t("tag only")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.references.length > 0 && (
        <div className="section">
          <h4>{t("Also shown on (not counted again)")}</h4>
          <ul className="loc-list">
            {o.references.map((r, i) => (
              <li key={i}>
                <button className="linkish" onClick={() => p.onNavigate({ page_index: r.page_index, bbox: r.bbox })}>
                  {r.sheet} · {r.view_title ?? tx(PAGE_TYPE_LABELS[r.view_type as string] ?? (r.view_type as string))}
                </button>
                {r.note && <span className="muted small"> {tx(r.note)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section">
        <h4>{t("Confidence")}</h4>
        <ConfidenceBar label={t("Opening detection")} value={o.confidence.detection} t={thr} />
        <ConfidenceBar label={t("Tag detection")} value={o.confidence.tag} t={thr} />
        <ConfidenceBar label={t("Width")} value={o.confidence.width} t={thr} />
        <ConfidenceBar label={t("Height")} value={o.confidence.height} t={thr} />
        <ConfidenceBar label={t("Dimension association")} value={o.confidence.association} t={thr} />
        <ConfidenceBar label={t("Overall")} value={o.confidence.overall} t={thr} />
      </div>
      {o.ai_original && o.edited_fields.length > 0 && (
        <div className="section">
          <h4>{t("Original AI result")}</h4>
          <div className="small">
            {t("Width")} {o.ai_original.width ? (o.ai_original.width.status === "conflict" ? t("conflict") : formatLength(o.ai_original.width.value, p.unit, o.ai_original.width.original_text)) : t("not found")} · {t("Height")}{" "}
            {o.ai_original.height ? (o.ai_original.height.status === "conflict" ? t("conflict") : formatLength(o.ai_original.height.value, p.unit, o.ai_original.height.original_text)) : t("not found")} · {t("Qty")} {o.ai_original.quantity ?? "—"} · {o.ai_original.tag ?? t("untagged")}
          </div>
        </div>
      )}
    </div>
  );
}

function EvidenceItem({ e, onNavigate }: { e: Evidence; onNavigate: (t: NavTarget) => void }) {
  const Icon = e.passed === true ? CheckCircle2 : e.passed === false ? XCircle : Circle;
  const cls = e.passed === true ? "ev ev-pass" : e.passed === false ? "ev ev-fail" : "ev ev-info";
  const nav = e.page_index !== null && e.page_index !== undefined;
  return (
    <li className={cls}>
      <Icon size={14} />
      <div>
        {nav ? (
          <button className="linkish" onClick={() => onNavigate({ page_index: e.page_index!, bbox: e.bbox, color: e.passed === false ? "#dc2626" : "#7c3aed" })}>
            {e.label}
          </button>
        ) : (
          <span>{e.label}</span>
        )}
        {e.detail && <div className="small muted">{e.detail}</div>}
      </div>
      {e.score !== null && e.score !== undefined && <span className="small muted">{Math.round(e.score * 100)}%</span>}
    </li>
  );
}

function EvidenceTab(p: Props) {
  const o = p.opening;
  const general = o.evidence.filter((e) => !["reference", "schedule"].includes(e.code));
  const cross = o.evidence.filter((e) => ["reference", "schedule"].includes(e.code));
  const block = (title: string, m: Measurement | null) => (
    <div className="section">
      <h4>
        {title}: {m ? (m.status === "conflict" ? t("conflict") : formatLength(m.value, p.unit, m.original_text)) : t("not found")}
        {m && m.status !== "conflict" && <span className="muted small"> · {Math.round(m.confidence * 100)}%</span>}
      </h4>
      {m ? (
        <ul className="ev-list">
          {m.evidence.map((e, i) => (
            <EvidenceItem key={i} e={e} onNavigate={p.onNavigate} />
          ))}
        </ul>
      ) : (
        <div className="small muted">{t("No dimension, callout or schedule entry could be tied to this opening. It was not guessed.")}</div>
      )}
    </div>
  );
  return (
    <div className="tab-body">
      <div className="section">
        <h4>{t("Opening")}</h4>
        <ul className="ev-list">
          {general.map((e, i) => (
            <EvidenceItem key={i} e={e} onNavigate={p.onNavigate} />
          ))}
          {general.length === 0 && <li className="small muted">{t("Added manually – no AI evidence.")}</li>}
        </ul>
      </div>
      {block(t("Width"), o.width)}
      {block(t("Height"), o.height)}
      {cross.length > 0 && (
        <div className="section">
          <h4>{t("Cross-references")}</h4>
          <ul className="ev-list">
            {cross.map((e, i) => (
              <EvidenceItem key={i} e={e} onNavigate={p.onNavigate} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ projectId, openingId }: { projectId: string; openingId: string }) {
  const q = useAudit(projectId, openingId);
  if (q.isLoading) return <div className="tab-body muted">{t("Loading…")}</div>;
  return (
    <div className="tab-body">
      <ul className="history">
        {(q.data ?? []).map((e) => (
          <li key={e.id}>
            <span className={`actor actor-${e.actor}`}>{e.actor === "ai" ? <Bot size={13} /> : <UserIcon size={13} />}</span>
            <div>
              <div>{e.message}</div>
              <div className="small muted">
                {new Date(e.created_at).toLocaleString(locale())} {e.user ? `· ${e.user}` : e.actor === "ai" ? `· ${t("AI extraction")}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "drawing_reference" -> "Drawing reference" in the current language */
function fieldLabel(f: string): string {
  return tx(f.replace(/_/g, " "));
}

function measInit(m: Measurement | null): string {
  if (!m || m.value === null) return "";
  if (m.source === "user" && m.original_text) return m.original_text;
  return m.original_text ?? String(Math.round(m.value));
}

function EditForm(p: Props & { onDone: () => void }) {
  const o = p.opening;
  const mut = useOpeningMutation(p.projectId);
  const toast = useToast();
  const [f, setF] = useState({
    type: o.type,
    tag: o.tag ?? "",
    width: measInit(o.width),
    height: measInit(o.height),
    quantity: o.quantity === null ? "" : String(o.quantity),
    page_index: o.page_index === null ? "" : String(o.page_index),
    drawing_reference: o.drawing_reference ?? "",
    floor: o.floor ?? "",
    room: o.room ?? "",
    notes: o.notes ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (f.type !== o.type) changes.type = f.type;
    if ((f.tag || null) !== (o.tag || null)) changes.tag = f.tag || null;
    if (f.width !== measInit(o.width)) changes.width = f.width.trim() ? { text: f.width.trim() } : null;
    if (f.height !== measInit(o.height)) changes.height = f.height.trim() ? { text: f.height.trim() } : null;
    const q = f.quantity === "" ? null : Number(f.quantity);
    if (q !== o.quantity) changes.quantity = q;
    const pi = f.page_index === "" ? null : Number(f.page_index);
    if (pi !== o.page_index) changes.page_index = pi;
    for (const k of ["drawing_reference", "floor", "room", "notes"] as const) {
      if ((f[k] || "") !== ((o[k] as string | null) || "")) changes[k] = f[k];
    }
    if (Object.keys(changes).length === 0) return p.onDone();
    mut.mutate(
      { id: o.id, body: { changes, version: o.version } },
      {
        onSuccess: () => {
          toast(t("Changes saved"));
          p.onDone();
        },
        onError: (err) => toast((err as Error).message, "error"),
      },
    );
  };

  return (
    <form className="tab-body form" onSubmit={save}>
      <div className="grid2">
        <label>
          {t("Type")}
          <select value={f.type} onChange={set("type")}>
            {Object.entries(p.openingTypes).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Tag")}
          <input value={f.tag} onChange={set("tag")} placeholder={t("e.g. {x}", { x: "W-03" })} />
        </label>
        <label>
          {t("Width")}
          <input value={f.width} onChange={set("width")} placeholder={`1200, 1200mm, 4'-0"`} />
        </label>
        <label>
          {t("Height")}
          <input value={f.height} onChange={set("height")} placeholder={`1500, 1.5m, 5'-0"`} />
        </label>
        <label>
          {t("Quantity")}
          <input type="number" min={0} value={f.quantity} onChange={set("quantity")} />
        </label>
        <label>
          {t("Page")}
          <select value={f.page_index} onChange={set("page_index")}>
            <option value="">—</option>
            {p.pages.map((pg) => (
              <option key={pg.id} value={pg.page_index}>
                {pg.page}. {pg.sheet_number ?? ""} {pg.page_type_label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Drawing reference")}
          <input value={f.drawing_reference} onChange={set("drawing_reference")} placeholder={t("e.g. {x}", { x: "A-102" })} />
        </label>
        <label>
          {t("Floor")}
          <input value={f.floor} onChange={set("floor")} />
        </label>
        <label className="span2">
          {t("Room")}
          <input value={f.room} onChange={set("room")} />
        </label>
        <label className="span2">
          {t("Notes")}
          <textarea rows={3} value={f.notes} onChange={set("notes")} />
        </label>
      </div>
      <p className="small muted">{t("Numbers without a unit use the project's default unit. Edited values are stored as user values; the original AI result is kept.")}</p>
      <div className="row gap">
        <button className="btn btn-primary" type="submit" disabled={mut.isPending}>
          {t("Save changes")}
        </button>
        <button className="btn" type="button" onClick={p.onDone}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
