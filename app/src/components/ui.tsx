import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Loader2, X, XCircle } from "lucide-react";
import type { Flag, Job, Opening, Thresholds } from "../api/types";
import { band, BAND_COLORS, pct } from "../lib/confidence";

export function StatusBadge({ o }: { o: Pick<Opening, "status" | "verification"> }) {
  if (o.verification.verified) return <span className="badge badge-green"><CheckCircle2 size={12} /> Verified</span>;
  if (o.status === "needs_review") return <span className="badge badge-amber"><AlertTriangle size={12} /> Needs review</span>;
  return <span className="badge badge-gray">Unverified</span>;
}

export function ConfidenceBadge({ value, t }: { value: number | null | undefined; t: Thresholds }) {
  const b = band(value, t);
  return (
    <span className="conf" title={`Confidence ${pct(value)}`}>
      <i style={{ background: BAND_COLORS[b] }} />
      {pct(value)}
    </span>
  );
}

export function ConfidenceBar({ label, value, t }: { label: string; value: number | null | undefined; t: Thresholds }) {
  const b = band(value, t);
  return (
    <div className="confbar">
      <span className="confbar-label">{label}</span>
      <span className="confbar-track">
        <span className="confbar-fill" style={{ width: `${Math.round((value ?? 0) * 100)}%`, background: BAND_COLORS[b] }} />
      </span>
      <span className="confbar-val">{value === null || value === undefined ? "n/a" : pct(value)}</span>
    </div>
  );
}

export function FlagChip({ f }: { f: Flag }) {
  const cls = f.severity === "error" ? "flag flag-error" : f.severity === "warning" ? "flag flag-warn" : "flag flag-info";
  const Icon = f.severity === "error" ? XCircle : f.severity === "warning" ? AlertTriangle : Info;
  return (
    <div className={cls}>
      <Icon size={14} />
      <div>
        <b>{f.label}</b>
        <div className="flag-msg">{f.message}</div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const STEP_ORDER = ["uploaded", "rendered", "analyzed", "classified", "dimensions", "openings", "associated", "schedules", "crossref", "scored"];

export function StepList({ job }: { job: Job }) {
  const steps = Object.entries(job.steps || {}).sort((a, b) => STEP_ORDER.indexOf(a[0]) - STEP_ORDER.indexOf(b[0]));
  return (
    <ul className="steps">
      {steps.map(([id, s]) => {
        const failed = job.status === "failed" && s.status === "running";
        return (
          <li key={id} className={`step step-${failed ? "failed" : s.status}`}>
            {s.status === "done" ? <CheckCircle2 size={16} /> : s.status === "running" ? (failed ? <XCircle size={16} /> : <Loader2 size={16} className="spin" />) : <CircleDashed size={16} />}
            <span>{s.label}{s.status === "running" && !failed ? "…" : ""}</span>
            {s.detail && s.status !== "pending" && <span className="muted small"> — {s.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// -- toasts ---------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}
const ToastCtx = createContext<(text: string, kind?: "ok" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
