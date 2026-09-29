import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FileStack, FlaskConical, FolderOpen, Home, Loader2, Plus, Upload } from "lucide-react";
import { api } from "../api/client";
import type { Opening, PageInfo, Project, Thresholds } from "../api/types";
import { qk, useOpenings, usePages, useProjects } from "../hooks/data";
import { useAuth } from "../hooks/auth";
import { Empty, fmtDate, Modal, ProgressBar, useToast } from "../components/ui";
import { lastProject, rememberProject } from "../components/Layout";
import { OpenProjectFileButton, SaveProjectFileButton } from "../components/ProjectFile";
import { DEFAULT_THRESHOLDS, pct } from "../lib/confidence";
import { measurementText } from "../lib/units";
import { t, tp } from "../i18n";
import { LanguageSwitch } from "../components/LanguageSwitch";

export function ProjectCard({ p }: { p: Project }) {
  const s = p.stats;
  const job = s?.job;
  const busy = job && ["queued", "running"].includes(job.status);
  return (
    <Link to={`/p/${p.id}/extraction`} className="pcard">
      <span className="corner" aria-hidden>
        <ArrowUpRight size={15} />
      </span>
      <div className="pcard-head">
        <h3>{p.name}</h3>
        {p.is_demo && <span className="badge badge-blue">{t("Demo")}</span>}
      </div>
      <div className="pcard-stats">
        <div>
          <b>{s?.pages ?? 0}</b>
          <span>{t("pages")}</span>
        </div>
        <div>
          <b>{s?.openings ?? 0}</b>
          <span>{t("openings")}</span>
        </div>
        <div className={s && s.needs_review > 0 ? "warn" : "ok"}>
          <b>{s?.needs_review ?? 0}</b>
          <span>{t("need review")}</span>
        </div>
      </div>
      {busy ? (
        <div className="pcard-job">
          <div className="small">
            <Loader2 size={12} className="spin" /> {job.message}
          </div>
          <ProgressBar value={job.progress} />
        </div>
      ) : job?.status === "failed" ? (
        <div className="small error-text">{t("Processing failed – open to see details")}</div>
      ) : (
        <div className="small muted">{t("Last processed: {date}", { date: fmtDate(p.last_processed_at) })}</div>
      )}
    </Link>
  );
}

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await api<Project>("/api/projects", { method: "POST", body: { name } });
      qc.invalidateQueries({ queryKey: qk.projects });
      onClose();
      nav(`/p/${p.id}/upload`);
    } catch (ex) {
      toast((ex as Error).message, "error");
    }
  };
  return (
    <Modal title={t("New project")} onClose={onClose}>
      <form className="form" onSubmit={create}>
        <label>
          {t("Project name")}
          <input autoFocus required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. {x}", { x: "Harbour Street Residence" })} />
        </label>
        <button className="btn btn-primary">{t("Create and upload plans")}</button>
      </form>
    </Modal>
  );
}

export function useCreateDemo() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const p = await api<Project>("/api/projects/demo", { method: "POST" });
      qc.invalidateQueries({ queryKey: qk.projects });
      nav(`/p/${p.id}/upload`);
    } catch (ex) {
      toast((ex as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

function Corner({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="corner" aria-label={label} title={label}>
      <ArrowUpRight size={15} />
    </Link>
  );
}

const SCHEDULE_TYPES = ["door_schedule", "window_schedule", "opening_schedule"];

function initials(s: string): string {
  const parts = s.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

// -- charts ------------------------------------------------------------------------

/** Ring gauge: one ratio against its limit (the high-confidence threshold). */
function ConfidenceRing({ value, thr }: { value: number | null; thr: Thresholds }) {
  const size = 156;
  const r = 58;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value ?? 0));
  const tick = (a: number) => {
    const ang = -Math.PI / 2 + a * 2 * Math.PI;
    return { x1: size / 2 + (r - 13) * Math.cos(ang), y1: size / 2 + (r - 13) * Math.sin(ang), x2: size / 2 + (r + 13) * Math.cos(ang), y2: size / 2 + (r + 13) * Math.sin(ang) };
  };
  return (
    <svg className="donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("Average confidence {a}; high-confidence threshold {b}", { a: pct(value), b: pct(thr.high) })}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={16} />
      {value !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={16}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <line {...tick(thr.high)} stroke="var(--ink)" strokeWidth={2} strokeLinecap="round">
        <title>{t("High-confidence threshold {p}", { p: pct(thr.high) })}</title>
      </line>
      <text x={size / 2} y={size / 2 + 4} textAnchor="middle" className="donut-value">
        {value === null ? "—" : Math.round(value * 100)}
        {value !== null && <tspan className="donut-unit">%</tspan>}
      </text>
      <text x={size / 2} y={size / 2 + 24} textAnchor="middle" className="donut-center">
        {t("average")}
      </text>
    </svg>
  );
}

function ConfidenceHistogram({ openings, thr }: { openings: Opening[]; thr: Thresholds }) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0 }));
  for (const o of openings) {
    const v = o.confidence.overall;
    if (v === null || v === undefined) continue;
    bins[Math.min(9, Math.floor(v * 10))].n += 1;
  }
  const max = Math.max(1, ...bins.map((b) => b.n));
  return (
    <>
      <div className="bars" role="img" aria-label={t("Distribution of opening confidence")}>
        {bins.map((b, i) => (
          <div key={i} className={`bar ${b.hi <= thr.high + 1e-9 ? "hl" : ""}`} style={{ height: `${Math.max(3, (b.n / max) * 100)}%` }}>
            <span className="tip">
              {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}% · {tp(b.n, "{n} opening", "{n} openings")}
            </span>
          </div>
        ))}
      </div>
      <div className="bar-axis spread">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
      <div className="chart-legend">
        <span>
          <i style={{ background: "var(--accent)" }} />
          {t("Below {p}", { p: pct(thr.high) })}
        </span>
        <span>
          <i style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(43,38,34,0.2)" }} />
          {t("High confidence")}
        </span>
      </div>
    </>
  );
}

function OpeningBarcode({ openings }: { openings: Opening[] }) {
  if (!openings.length) return null;
  return (
    <>
      <div className="barcode" role="img" aria-label={t("Confidence of each opening")}>
        {openings.map((o) => (
          <div key={o.id} className={`code ${o.status === "needs_review" && !o.verification.verified ? "hl" : ""}`} style={{ height: `${Math.max(6, (o.confidence.overall ?? 0) * 100)}%` }}>
            <span className="tip">
              {o.tag ?? o.ref} · {pct(o.confidence.overall)}
              {o.verification.verified ? ` · ${t("verified")}` : o.status === "needs_review" ? ` · ${t("needs review")}` : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span>
          <i style={{ background: "var(--accent-deep)" }} />
          {t("Needs review")}
        </span>
        <span>
          <i style={{ background: "rgba(120,100,80,0.35)" }} />
          {t("Other openings · bar height = confidence")}
        </span>
      </div>
    </>
  );
}

// -- hero drawing with opening hotspots ------------------------------------------------

function HeroSheet({ pid, page, openings, unit }: { pid: string; page: PageInfo; openings: Opening[]; unit: Project["settings"]["display_unit"] }) {
  const [hover, setHover] = useState<string | null>(null);
  const spots = useMemo(() => {
    const out: { key: string; o: Opening; x: number; y: number }[] = [];
    for (const o of openings) {
      o.instances.forEach((ins, i) => {
        if (ins.page_index !== page.page_index || !ins.counted) return;
        out.push({ key: `${o.id}:${i}`, o, x: ((ins.bbox.x + ins.bbox.width / 2) / page.width) * 100, y: ((ins.bbox.y + ins.bbox.height / 2) / page.height) * 100 });
      });
    }
    return out;
  }, [openings, page]);
  const ratio = page.width / page.height;
  const hovered = spots.find((s) => s.key === hover);
  return (
    <div className="hero-sheet" style={{ aspectRatio: `${ratio}`, maxWidth: `min(820px, max(340px, calc((100vh - 500px) * ${ratio.toFixed(4)})))` }}>
      {page.image_url ? <img src={page.image_url} alt={`${page.sheet_number ?? ""} ${page.page_type_label}`} draggable={false} /> : <div className="viewer-empty">{t("Rendering…")}</div>}
      {spots.map((s) => (
        <Link
          key={s.key}
          to={`/p/${pid}/extraction?opening=${s.o.id}&page=${page.page_index}`}
          className={`hotspot ${s.o.status === "needs_review" && !s.o.verification.verified ? "review" : ""}`}
          style={{ left: `${s.x}%`, top: `${s.y}%` }}
          aria-label={`${s.o.tag ?? s.o.ref} ${s.o.type_label}`}
          onMouseEnter={() => setHover(s.key)}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(s.key)}
          onBlur={() => setHover(null)}
        />
      ))}
      {hovered && (
        <div className="hotspot-tip" style={{ left: `${hovered.x}%`, top: `${hovered.y}%` }}>
          <b>{hovered.o.tag ?? hovered.o.ref}</b> {hovered.o.type_label} · {measurementText(hovered.o.width, unit)} × {measurementText(hovered.o.height, unit)}
        </div>
      )}
      <span className="hero-sheet-label">
        {page.sheet_number ? `${page.sheet_number} · ` : ""}
        {page.sheet_title || page.page_type_label}
      </span>
    </div>
  );
}

// -- dashboard ---------------------------------------------------------------------------

function ProjectDashboard({ project, all, onPick }: { project: Project; all: Project[]; onPick: (id: string) => void }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const pid = project.id;
  const openings = useOpenings(pid);
  const pages = usePages(pid);
  const thr = project.settings.thresholds ?? DEFAULT_THRESHOLDS;
  const unit = project.settings.display_unit ?? "mm";
  const list = openings.data ?? [];
  const pageList = pages.data ?? [];
  const job = project.stats?.job;
  const busy = !!job && ["queued", "running"].includes(job.status);

  const m = useMemo(() => {
    const confs = list.map((o) => o.confidence.overall).filter((v): v is number => typeof v === "number");
    const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    const verified = list.filter((o) => o.verification.verified).length;
    const review = list.filter((o) => o.status === "needs_review" && !o.verification.verified).length;
    const qty = list.reduce((a, o) => a + (o.quantity ?? 0), 0);
    const high = confs.filter((v) => v >= thr.high).length;
    const med = confs.filter((v) => v < thr.high && v >= thr.medium).length;
    const issues = new Map<string, number>();
    for (const o of list) {
      if (o.verification.verified) continue;
      for (const f of o.flags) if (f.severity !== "info") issues.set(f.label, (issues.get(f.label) ?? 0) + 1);
    }
    const types = new Map<string, number>();
    for (const o of list) types.set(o.type_label, (types.get(o.type_label) ?? 0) + (o.quantity ?? 0));
    const planSheets = pageList.filter((p) => p.page_type === "floor_plan" || p.page_type === "elevation").length;
    const isSchedule = (x: string | null) => !!x && SCHEDULE_TYPES.includes(x);
    const scheduleSheets = pageList.filter((p) => isSchedule(p.page_type) || p.secondary_types.some(isSchedule)).length;
    return {
      avg,
      verified,
      review,
      qty,
      high,
      med,
      low: confs.length - high - med,
      issues: [...issues.entries()].sort((a, b) => b[1] - a[1]),
      types: [...types.entries()].sort((a, b) => b[1] - a[1]),
      planSheets,
      scheduleSheets,
    };
  }, [list, pageList, thr]);

  const heroPage = pageList.find((p) => p.page_type === "floor_plan" && p.image_url) ?? pageList.find((p) => p.image_url);
  const title = project.info.project_name || project.name;
  const sub = [project.info.project_address, project.info.drawing_set_name].filter(Boolean).join(" · ");
  const verifiedShare = list.length ? m.verified / list.length : 0;

  return (
    <div className="dash">
      {/* left column */}
      <div className="dash-col">
        <div className="dash-card">
          <Corner to="/projects" label={t("All projects")} />
          <div className="person">
            <span className="avatar">{user?.name ? initials(user.name) : <FolderOpen size={18} />}</span>
            <div className="grow" style={{ minWidth: 0, paddingRight: 30 }}>
              <div className="b ellipsis">{user?.name || t("This device")}</div>
              <div className="small muted">{t("Stored on this device")}</div>
            </div>
          </div>
          <div className="row gap" style={{ marginTop: 14 }}>
            <Link to={`/p/${pid}/review`} className="pill">
              {tp(m.review, "{n} needs review", "{n} need review")} <b>!</b>
            </Link>
            {project.is_demo && <span className="pill">{t("Demo data")}</span>}
            <span className="grow" />
            <SaveProjectFileButton projectId={pid} compact />
          </div>
        </div>

        <div className="dash-card">
          <Corner to={`/p/${pid}/review`} label={t("Open review queue")} />
          <h3>{t("Confidence distribution")}</h3>
          <ConfidenceHistogram openings={list} thr={thr} />
        </div>

        <div className="dash-card grow-card">
          <Corner to={`/p/${pid}/measurements`} label={t("Measurement schedule")} />
          <h3>{t("Openings by type")}</h3>
          <div className="dash-row">
            <div>
              <div className="dash-label">{t("Total quantity")}</div>
              <div className="dash-num lg">{m.qty}</div>
            </div>
            <div />
            <div>
              <div className="dash-label">{t("Tags / types")}</div>
              <div className="dash-num lg">{list.length}</div>
            </div>
          </div>
          <div className="chips">
            {m.types.map(([k, n]) => (
              <span key={k} className="chip">
                {k} <b>{n}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* hero */}
      <div className="hero">
        <div className="hero-title">
          <h1>{title}</h1>
          <p>
            {sub && (
              <>
                {sub}
                <br />
              </>
            )}
            {busy ? t("Processing drawings…") : t("Last processed {date}", { date: fmtDate(project.last_processed_at) })}
          </p>
        </div>
        {busy ? (
          <div className="card hero-empty">
            <Loader2 size={26} className="spin" />
            <div>{job?.message ?? t("Processing…")}</div>
            <ProgressBar value={job?.progress ?? 0} />
            <Link to={`/p/${pid}/upload`} className="btn btn-sm">
              {t("View progress")}
            </Link>
          </div>
        ) : heroPage ? (
          <HeroSheet pid={pid} page={heroPage} openings={list} unit={unit} />
        ) : (
          <div className="card hero-empty">
            <Upload size={28} />
            <div>{t("No drawings in this project yet.")}</div>
            <Link to={`/p/${pid}/upload`} className="btn btn-primary">
              {t("Upload plans")}
            </Link>
          </div>
        )}
        <div className="pager" aria-label={t("Projects")}>
          <button onClick={() => nav("/projects")} title={t("All projects")} aria-label={t("All projects")}>
            <Home size={15} />
          </button>
          {all.slice(0, 6).map((p, i) => (
            <button key={p.id} className={p.id === pid ? "active" : ""} onClick={() => onPick(p.id)} title={p.name} aria-label={t("Show {name}", { name: p.name })} aria-current={p.id === pid}>
              {i + 1}
            </button>
          ))}
        </div>
        <div className="dash-card dash-bottom">
          <Corner to={`/p/${pid}/measurements`} label={t("Measurement schedule")} />
          <h3>{t("Extraction status")}</h3>
          <div className="stat-strip">
            <div>
              <div className="dash-label">{t("Documents")}</div>
              <div className="dash-num">{project.stats?.documents ?? 0}</div>
            </div>
            <div>
              <div className="dash-label">{t("Pages")}</div>
              <div className="dash-num">{pageList.length}</div>
            </div>
            <div>
              <div className="dash-label">{t("Plan / elevation sheets")}</div>
              <div className="dash-num">{m.planSheets}</div>
            </div>
            <div>
              <div className="dash-label">{t("Schedule sheets")}</div>
              <div className="dash-num">{m.scheduleSheets}</div>
            </div>
          </div>
          <OpeningBarcode openings={list} />
        </div>
      </div>

      {/* right column */}
      <div className="dash-col">
        <div className="dash-card">
          <Corner to="/settings" label={t("Confidence thresholds")} />
          <h3>{t("Average confidence")}</h3>
          <ConfidenceRing value={m.avg} thr={thr} />
          <div className="dash-row" style={{ marginTop: 10 }}>
            <div>
              <div className="dash-label">{t("High")} ≥{pct(thr.high)}</div>
              <div className="dash-num">{m.high}</div>
            </div>
            <div>
              <div className="dash-label">{t("Medium")}</div>
              <div className="dash-num">{m.med}</div>
            </div>
            <div>
              <div className="dash-label">{t("Low")} &lt;{pct(thr.medium)}</div>
              <div className="dash-num">{m.low}</div>
            </div>
          </div>
        </div>

        <div className="dash-card">
          <Corner to={`/p/${pid}/review`} label={t("Review queue")} />
          <h3>{t("Review progress")}</h3>
          <div className="dash-row">
            <div>
              <div className="dash-label">{t("Verified")}</div>
              <div className="dash-num">{pct(verifiedShare)}</div>
            </div>
            <div />
            <div>
              <div className="dash-label">{t("Left to check")}</div>
              <div className="dash-num">{list.length - m.verified}</div>
            </div>
          </div>
          <div className="status-bar stacked" role="img" aria-label={t("{a} verified, {b} need review, {c} unverified of {n} openings", { a: m.verified, b: m.review, c: list.length - m.verified - m.review, n: list.length })}>
            {m.verified > 0 && <span className="s-verified" style={{ flex: m.verified }} title={`${m.verified} ${t("verified")}`} />}
            {m.review > 0 && <span className="s-review" style={{ flex: m.review }} title={`${m.review} ${t("need review")}`} />}
            {list.length - m.verified - m.review > 0 && <span className="s-open" style={{ flex: list.length - m.verified - m.review }} title={`${list.length - m.verified - m.review} ${t("unverified")}`} />}
          </div>
          <div className="chart-legend">
            <span>
              <i style={{ background: "var(--mint)" }} />
              {t("Verified")} {m.verified}
            </span>
            <span>
              <i style={{ background: "var(--accent)" }} />
              {t("Needs review")} {m.review}
            </span>
            <span>
              <i style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(43,38,34,0.2)" }} />
              {t("Unverified")} {list.length - m.verified - m.review}
            </span>
          </div>
        </div>

        <div className="dash-card grow-card">
          <Corner to={`/p/${pid}/review`} label={t("Resolve issues")} />
          <h3>{t("Open issues")}</h3>
          {m.issues.length === 0 ? (
            <p className="small muted center">{list.length ? t("No open warnings — every unverified opening passed its checks.") : t("Nothing extracted yet.")}</p>
          ) : (
            <ul className="issue-list">
              {m.issues.slice(0, 5).map(([label, n]) => (
                <li key={label}>
                  <span>{label}</span>
                  <b>{n}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState<string | null>(() => lastProject());
  const demo = useCreateDemo();
  const list = projects.data ?? [];
  const project = list.find((p) => p.id === focus) ?? list[0];

  if (projects.isLoading) {
    return (
      <div className="dash-empty">
        <Loader2 size={22} className="spin" color="#fffaf2" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="dash-empty">
        <div className="hero-title">
          <h1>PlanMeasure AI</h1>
          <p>{t("Doors, windows and openings — measured from your drawings, with evidence for every value.")}</p>
        </div>
        <div className="card welcome">
          <Empty icon={<FileStack size={34} />} title={t("No projects yet")}>
            <p className="muted">{t("Upload a drawing set, or explore the sample project to see the full workflow without uploading anything.")}</p>
            <div className="row gap wrap center-row">
              <button className="btn btn-primary" onClick={demo.run} disabled={demo.busy}>
                <FlaskConical size={15} /> {demo.busy ? t("Creating demo…") : t("Try the demo project")}
              </button>
              <button className="btn" onClick={() => setCreating(true)}>
                <Plus size={15} /> {t("New project")}
              </button>
              <OpenProjectFileButton />
            </div>
            <div className="row center-row" style={{ marginTop: 18 }}>
              <LanguageSwitch />
            </div>
          </Empty>
        </div>
        {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      </div>
    );
  }

  return (
    <ProjectDashboard
      project={project}
      all={list}
      onPick={(id) => {
        setFocus(id);
        rememberProject(id);
      }}
    />
  );
}
