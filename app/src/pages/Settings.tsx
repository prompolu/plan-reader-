import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { DisplayUnit, Project, ProjectInfo } from "../api/types";
import { lastProject } from "../components/Layout";
import { fmtDate, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { qk, useProjects, useRuns, useSystem } from "../hooks/data";
import { BAND_COLORS } from "../lib/confidence";
import { UNIT_LABELS } from "../lib/units";

export default function Settings() {
  const projects = useProjects();
  const [pid, setPid] = useState<string | null>(lastProject());
  const project = projects.data?.find((p) => p.id === pid) ?? projects.data?.[0];
  const system = useSystem();
  const { user } = useAuth();

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      {projects.data && projects.data.length > 0 && project && (
        <>
          <div className="row gap">
            <span className="muted">Project</span>
            <select value={project.id} onChange={(e) => setPid(e.target.value)} aria-label="Project">
              {projects.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <ProjectSettings key={project.id} project={project} />
          <Runs project={project} />
        </>
      )}
      <div className="card">
        <h3>System</h3>
        {system.data && (
          <dl className="kv">
            <dt>Application</dt>
            <dd>v{system.data.app_version}</dd>
            <dt>Extraction pipeline</dt>
            <dd>v{system.data.extraction_version}</dd>
            <dt>OCR</dt>
            <dd>
              {system.data.ocr.provider} {system.data.ocr.version ?? ""} {system.data.ocr.available ? "" : <span className="error-text">(not available – scanned drawings cannot be read)</span>}
            </dd>
            <dt>Vision model</dt>
            <dd>
              {system.data.vision.configured ? (
                <>
                  {system.data.vision.provider} · {system.data.vision.model}
                </>
              ) : (
                <span className="muted">Not configured – ambiguous cases are flagged for review instead</span>
              )}
              <div className="small muted">Used for {system.data.vision.used_for}.</div>
            </dd>
            <dt>Upload limits</dt>
            <dd>
              {system.data.limits.max_upload_mb} MB per file · {system.data.limits.max_pages_per_document} pages per PDF · {system.data.limits.max_files_per_upload} files per upload
            </dd>
            <dt>Storage</dt>
            <dd>On this device · nothing is uploaded</dd>
          </dl>
        )}
      </div>
      <DeviceCard name={user?.name ?? ""} />
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function DeviceCard({ name: initial }: { name: string }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(initial);
  const [usage, setUsage] = useState<{ used: number; quota: number; persisted: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      if (!navigator.storage?.estimate) return;
      const e = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0, persisted });
    })().catch(() => undefined);
  }, []);
  const save = async () => {
    try {
      await api("/api/auth/me", { method: "PATCH", body: { name } });
      await refresh();
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="card">
      <h3>This device</h3>
      <p className="small">
        No account and no server: drawings, extraction results, your edits and the audit trail are stored on this device only. To continue on another computer or phone, use <b>Save project file</b> and <b>Open project file</b>. Uninstalling the app or clearing this site's data deletes the projects stored here – keep project files as backups.
      </p>
      <fieldset>
        <legend>Your name</legend>
        <label>
          Shown in the audit trail and on exported reports
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Carter" />
        </label>
        <div>
          <button className="btn" onClick={save} disabled={name.trim() === initial.trim()}>
            Save name
          </button>
        </div>
      </fieldset>
      {usage && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Using {fmtBytes(usage.used)}
          {usage.quota ? ` of ${fmtBytes(usage.quota)} available` : ""}
          {usage.persisted ? " · storage is protected from automatic clean-up" : ""}
        </p>
      )}
    </div>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = project.role !== "viewer";
  const [high, setHigh] = useState(project.settings.thresholds.high);
  const [medium, setMedium] = useState(project.settings.thresholds.medium);
  const [unit, setUnit] = useState<DisplayUnit>(project.settings.display_unit);
  const [defUnit, setDefUnit] = useState(project.settings.default_unit);
  const [name, setName] = useState(project.name);
  const [info, setInfo] = useState<ProjectInfo>(project.info);
  useEffect(() => {
    setInfo(project.info);
  }, [project.info]);

  const save = async () => {
    if (!(medium < high)) return toast("The yellow threshold must be below the green threshold", "error");
    try {
      await api(`/api/projects/${project.id}`, { method: "PATCH", body: { name, info, settings: { thresholds: { high, medium }, display_unit: unit, default_unit: defUnit } } });
      qc.invalidateQueries({ queryKey: qk.projects });
      qc.invalidateQueries({ queryKey: qk.project(project.id) });
      qc.invalidateQueries({ queryKey: qk.openings(project.id) });
      toast("Settings saved");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const set = (k: keyof ProjectInfo) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInfo({ ...info, [k]: e.target.value });

  return (
    <div className="card">
      <h3>Project settings</h3>
      <div className="grid2 form">
        <fieldset>
          <legend>Confidence thresholds</legend>
          <label>
            <span>
              <i className="dot" style={{ background: BAND_COLORS.green }} /> High confidence (green) at or above {Math.round(high * 100)}%
            </span>
            <input type="range" min={0.5} max={0.99} step={0.01} value={high} disabled={!canEdit} onChange={(e) => setHigh(Number(e.target.value))} />
          </label>
          <label>
            <span>
              <i className="dot" style={{ background: BAND_COLORS.yellow }} /> Review recommended (yellow) at or above {Math.round(medium * 100)}%; below is red
            </span>
            <input type="range" min={0.2} max={0.95} step={0.01} value={medium} disabled={!canEdit} onChange={(e) => setMedium(Number(e.target.value))} />
          </label>
          <div className="small muted">Items below the yellow threshold are added to the review queue.</div>
        </fieldset>
        <fieldset>
          <legend>Units</legend>
          <label>
            Default display unit
            <select value={unit} disabled={!canEdit} onChange={(e) => setUnit(e.target.value as DisplayUnit)}>
              {(Object.keys(UNIT_LABELS) as DisplayUnit[]).map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Unit for numbers typed without a unit
            <select value={defUnit} disabled={!canEdit} onChange={(e) => setDefUnit(e.target.value)}>
              <option value="mm">Millimetres</option>
              <option value="cm">Centimetres</option>
              <option value="m">Metres</option>
              <option value="in">Inches</option>
            </select>
          </label>
          <div className="small muted">Display units never change stored values.</div>
        </fieldset>
        <fieldset className="span2">
          <legend>Project information</legend>
          <div className="grid2">
            <label>
              Project (in the app)
              <input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Project name (reports)
              <input value={info.project_name ?? ""} disabled={!canEdit} onChange={set("project_name")} />
            </label>
            <label>
              Drawing set name
              <input value={info.drawing_set_name ?? ""} disabled={!canEdit} onChange={set("drawing_set_name")} />
            </label>
            <label>
              Project address
              <input value={info.project_address ?? ""} disabled={!canEdit} onChange={set("project_address")} />
            </label>
            <label>
              Prepared by
              <input value={info.prepared_by ?? ""} disabled={!canEdit} onChange={set("prepared_by")} />
            </label>
            <label>
              Date
              <input type="date" value={info.date ?? ""} disabled={!canEdit} onChange={set("date")} />
            </label>
            <label className="span2">
              Notes
              <textarea rows={2} value={info.notes ?? ""} disabled={!canEdit} onChange={set("notes")} />
            </label>
          </div>
        </fieldset>
      </div>
      {canEdit && (
        <button className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      )}
    </div>
  );
}

function Runs({ project }: { project: Project }) {
  const runs = useRuns(project.id);
  const qc = useQueryClient();
  const toast = useToast();
  const reprocess = async () => {
    try {
      await api(`/api/projects/${project.id}/process`, { method: "POST" });
      qc.invalidateQueries({ queryKey: qk.jobs(project.id) });
      qc.invalidateQueries({ queryKey: qk.projects });
      toast("Re-extraction queued – edited and verified openings will not be overwritten");
      setTimeout(() => runs.refetch(), 3000);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="card">
      <div className="row between">
        <h3>Extraction versions</h3>
        {project.role !== "viewer" && (
          <button className="btn btn-sm" onClick={reprocess}>
            <RefreshCw size={14} /> Reprocess project
          </button>
        )}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Processed</th>
            <th>Pipeline</th>
            <th>Models</th>
            <th>Trigger</th>
            <th>Result</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                {fmtDate(r.finished_at ?? r.started_at)} {r.current && <span className="badge badge-blue">current</span>}
              </td>
              <td>v{r.version}</td>
              <td className="small">
                OCR: {r.models.ocr ?? "—"} · Vision: {r.models.vision_model ?? "none"}
                {r.models.vision_calls ? ` (${r.models.vision_calls} calls)` : ""}
              </td>
              <td>{r.trigger}</td>
              <td className="small">
                {r.stats.records ?? 0} types · {r.stats.physical_openings ?? 0} openings
                {r.stats.merge && ` · ${r.stats.merge.pending_confirmation ?? 0} awaiting confirmation`}
                {r.warnings.length > 0 && <div className="error-text">{r.warnings.slice(0, 2).join("; ")}</div>}
              </td>
              <td>
                <span className={`badge ${r.status === "succeeded" ? "badge-green" : r.status === "failed" ? "badge-red" : "badge-blue"}`}>{r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
