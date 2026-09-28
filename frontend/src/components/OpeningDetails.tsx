import { useEffect, useState } from "react";
import { Bot, Check, CheckCircle2, Circle, Pencil, RotateCcw, Trash2, User as UserIcon, XCircle } from "lucide-react";
import type { BBox, DisplayUnit, Evidence, Measurement, Opening, PageInfo, Thresholds } from "../api/types";
import { useAudit, useOpeningMutation } from "../hooks/data";
import { formatLength, SOURCE_LABELS } from "../lib/units";
import { ConfidenceBadge, ConfidenceBar, FlagChip, StatusBadge, useToast } from "./ui";

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
            <span className="tag">{o.tag || "Untagged"}</span>
            <span>{o.type_label}</span>
          </div>
          <div className="muted small">
            {o.ref} · {o.source === "user" ? "added manually" : "AI extracted"}
            {o.edited_fields.length > 0 && ` · edited: ${o.edited_fields.join(", ")}`}
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
            <Pencil size={14} /> {editing ? "Cancel edit" : "Edit"}
          </button>
          <button className={`btn ${verified ? "" : "btn-primary"}`} onClick={() => act({ id: o.id, path: "/verify", method: "POST", body: { verified: !verified } }, verified ? "Verification removed" : `${o.tag || o.ref} verified`)}>
            {verified ? <RotateCcw size={14} /> : <Check size={14} />} {verified ? "Unverify" : "Verify"}
          </button>
          <button
            className="btn btn-danger-ghost"
            onClick={() => {
              if (confirm(`Delete ${o.tag || o.ref}? It is kept in the audit history and can be restored.`))
                mut.mutate({ id: o.id, method: "DELETE" }, { onSuccess: () => { toast("Opening deleted"); p.onDeleted?.(); } });
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
      {o.pending_ai && (
        <div className="banner banner-info">
          <b>Re-extraction produced different values.</b> Your edits were kept.
          <div className="small">
            AI now says: width {o.pending_ai.width ? formatLength(o.pending_ai.width.value, p.unit, o.pending_ai.width.original_text) : "—"}, height{" "}
            {o.pending_ai.height ? formatLength(o.pending_ai.height.value, p.unit, o.pending_ai.height.original_text) : "—"}, qty {o.pending_ai.quantity ?? "—"}
          </div>
          {p.canEdit && (
            <div className="row gap">
              <button className="btn btn-sm" onClick={() => act({ id: o.id, path: "/ai-update", method: "POST", body: { accept: true } }, "AI values accepted")}>
                Accept AI values
              </button>
              <button className="btn btn-sm" onClick={() => act({ id: o.id, path: "/ai-update", method: "POST", body: { accept: false } }, "Kept your values")}>
                Keep mine
              </button>
            </div>
          )}
        </div>
      )}
      <div className="tabs">
        {(["details", "evidence", "history"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "details" ? "Details" : t === "evidence" ? "Evidence" : "History"}
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
        <div className="meas-value">Needs review</div>
        <div className="small muted">No reliable {field} found on the drawings. Nothing was assumed.</div>
      </div>
    );
  if (m.status === "conflict")
    return (
      <div className="meas meas-conflict">
        <div className="meas-label">{label}</div>
        <div className="meas-value">Conflict</div>
        <div className="small">The sources disagree — choose the correct value or enter one:</div>
        {(m.candidates ?? []).map((c, i) => (
          <div key={i} className="cand">
            <button className="linkish" onClick={() => p.onNavigate({ page_index: c.page_index, bbox: c.bbox, color: "#dc2626" })}>
              {c.label}: <b>{formatLength(c.value, p.unit, c.original_text)}</b> <span className="muted">(“{c.original_text}”)</span>
            </button>
            {p.canEdit && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  mut.mutate({ id: o.id, path: "/resolve-conflict", method: "POST", body: { field, candidate_index: i } }, { onSuccess: () => toast(`${label} set from ${c.label}`), onError: (e) => toast((e as Error).message, "error") })
                }
              >
                Use this
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
        {m.status === "inferred" && <span className="badge badge-amber">Inferred</span>}
        {m.sheet && m.page_index !== null && (
          <button className="linkish" onClick={() => p.onNavigate({ page_index: m.page_index!, bbox: m.bbox, color: "#1d4ed8" })}>
            {m.sheet}
          </button>
        )}
        <span className="muted"> · {Math.round((m.confidence ?? 0) * 100)}%</span>
      </div>
      {m.previous && <div className="small muted">Previously: {m.previous.value !== null ? formatLength(m.previous.value, p.unit, m.previous.original_text) : m.previous.status}</div>}
    </div>
  );
}

function DetailsTab(p: Props) {
  const o = p.opening;
  const t = p.thresholds;
  const basis: Record<string, string> = {
    plan_instances: "counted from floor plans",
    elevation_references: "counted from elevations",
    schedule_only: "schedule only – not located, not counted",
    reference_only: "shown only on details",
    user: "set by user",
  };
  return (
    <div className="tab-body">
      <div className="meas-grid">
        <MeasurementBlock label="Width" m={o.width} field="width" p={p} />
        <MeasurementBlock label="Height" m={o.height} field="height" p={p} />
      </div>
      <dl className="kv">
        <dt>Quantity</dt>
        <dd>
          <b>{o.quantity ?? "—"}</b> <span className="muted small">{basis[o.quantity_basis ?? ""] ?? o.quantity_basis}</span>
        </dd>
        <dt>Source page</dt>
        <dd>
          {o.page_index !== null ? (
            <button className="linkish" onClick={() => p.onNavigate({ page_index: o.page_index!, bbox: o.bbox })}>
              {o.drawing_reference ?? "Page"} · page {o.page}
            </button>
          ) : (
            "—"
          )}
        </dd>
        <dt>Floor</dt>
        <dd>{o.floor || "—"}</dd>
        <dt>Room</dt>
        <dd>{o.room || "—"}</dd>
        {o.notes && (
          <>
            <dt>Notes</dt>
            <dd className="pre">{o.notes}</dd>
          </>
        )}
      </dl>
      {o.flags.length > 0 && (
        <div className="section">
          <h4>{o.verification.verified ? "Flags (acknowledged by verification)" : "Needs attention"}</h4>
          {o.flags.map((f, i) => (
            <FlagChip key={i} f={f} />
          ))}
        </div>
      )}
      {o.instances.length > 0 && (
        <div className="section">
          <h4>Located on plans ({o.instances.length})</h4>
          <ul className="loc-list">
            {o.instances.map((inst, i) => (
              <li key={i}>
                <button className="linkish" onClick={() => p.onNavigate({ page_index: inst.page_index, bbox: inst.bbox })}>
                  {inst.sheet} · {[inst.floor, inst.room].filter(Boolean).join(" · ") || `page ${inst.page_index + 1}`}
                </button>
                {inst.width_text && <span className="muted small"> dim “{inst.width_text}”</span>}
                {inst.geometry_missing && <span className="badge badge-amber">tag only</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.references.length > 0 && (
        <div className="section">
          <h4>Also shown on (not counted again)</h4>
          <ul className="loc-list">
            {o.references.map((r, i) => (
              <li key={i}>
                <button className="linkish" onClick={() => p.onNavigate({ page_index: r.page_index, bbox: r.bbox })}>
                  {r.sheet} · {r.view_title ?? r.view_type}
                </button>
                {r.note && <span className="muted small"> {r.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section">
        <h4>Confidence</h4>
        <ConfidenceBar label="Opening detection" value={o.confidence.detection} t={t} />
        <ConfidenceBar label="Tag detection" value={o.confidence.tag} t={t} />
        <ConfidenceBar label="Width" value={o.confidence.width} t={t} />
        <ConfidenceBar label="Height" value={o.confidence.height} t={t} />
        <ConfidenceBar label="Dimension association" value={o.confidence.association} t={t} />
        <ConfidenceBar label="Overall" value={o.confidence.overall} t={t} />
      </div>
      {o.ai_original && o.edited_fields.length > 0 && (
        <div className="section">
          <h4>Original AI result</h4>
          <div className="small">
            Width {o.ai_original.width ? (o.ai_original.width.status === "conflict" ? "conflict" : formatLength(o.ai_original.width.value, p.unit, o.ai_original.width.original_text)) : "not found"} · Height{" "}
            {o.ai_original.height ? (o.ai_original.height.status === "conflict" ? "conflict" : formatLength(o.ai_original.height.value, p.unit, o.ai_original.height.original_text)) : "not found"} · Qty {o.ai_original.quantity ?? "—"} · {o.ai_original.tag ?? "untagged"}
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
        {title}: {m ? (m.status === "conflict" ? "conflict" : formatLength(m.value, p.unit, m.original_text)) : "not found"}
        {m && m.status !== "conflict" && <span className="muted small"> · {Math.round(m.confidence * 100)}%</span>}
      </h4>
      {m ? (
        <ul className="ev-list">
          {m.evidence.map((e, i) => (
            <EvidenceItem key={i} e={e} onNavigate={p.onNavigate} />
          ))}
        </ul>
      ) : (
        <div className="small muted">No dimension, callout or schedule entry could be tied to this opening. It was not guessed.</div>
      )}
    </div>
  );
  return (
    <div className="tab-body">
      <div className="section">
        <h4>Opening</h4>
        <ul className="ev-list">
          {general.map((e, i) => (
            <EvidenceItem key={i} e={e} onNavigate={p.onNavigate} />
          ))}
          {general.length === 0 && <li className="small muted">Added manually – no AI evidence.</li>}
        </ul>
      </div>
      {block("Width", o.width)}
      {block("Height", o.height)}
      {cross.length > 0 && (
        <div className="section">
          <h4>Cross-references</h4>
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
  if (q.isLoading) return <div className="tab-body muted">Loading…</div>;
  return (
    <div className="tab-body">
      <ul className="history">
        {(q.data ?? []).map((e) => (
          <li key={e.id}>
            <span className={`actor actor-${e.actor}`}>{e.actor === "ai" ? <Bot size={13} /> : <UserIcon size={13} />}</span>
            <div>
              <div>{e.message}</div>
              <div className="small muted">
                {new Date(e.created_at).toLocaleString()} {e.user ? `· ${e.user}` : e.actor === "ai" ? "· AI extraction" : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
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
          toast("Changes saved");
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
          Type
          <select value={f.type} onChange={set("type")}>
            {Object.entries(p.openingTypes).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <input value={f.tag} onChange={set("tag")} placeholder="e.g. W-03" />
        </label>
        <label>
          Width
          <input value={f.width} onChange={set("width")} placeholder={`1200, 1200mm, 4'-0"`} />
        </label>
        <label>
          Height
          <input value={f.height} onChange={set("height")} placeholder={`1500, 1.5m, 5'-0"`} />
        </label>
        <label>
          Quantity
          <input type="number" min={0} value={f.quantity} onChange={set("quantity")} />
        </label>
        <label>
          Page
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
          Drawing reference
          <input value={f.drawing_reference} onChange={set("drawing_reference")} placeholder="e.g. A-102" />
        </label>
        <label>
          Floor
          <input value={f.floor} onChange={set("floor")} />
        </label>
        <label className="span2">
          Room
          <input value={f.room} onChange={set("room")} />
        </label>
        <label className="span2">
          Notes
          <textarea rows={3} value={f.notes} onChange={set("notes")} />
        </label>
      </div>
      <p className="small muted">Numbers without a unit use the project's default unit. Edited values are stored as user values; the original AI result is kept.</p>
      <div className="row gap">
        <button className="btn btn-primary" type="submit" disabled={mut.isPending}>
          Save changes
        </button>
        <button className="btn" type="button" onClick={p.onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
