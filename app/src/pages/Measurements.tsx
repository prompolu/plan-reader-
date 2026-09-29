import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { api, downloadBlob } from "../api/client";
import type { DisplayUnit, ProjectInfo } from "../api/types";
import AddOpeningModal from "../components/AddOpeningModal";
import OpeningTable from "../components/OpeningTable";
import ScheduleView from "../components/ScheduleView";
import { Modal, useToast } from "../components/ui";
import { qk, usePages, useSchedule } from "../hooks/data";
import { useWorkspace } from "../hooks/workspace";
import { UnitSwitch } from "./Extraction";
import { t, tp } from "../i18n";

const GROUPS = [
  ["type", "Type"],
  ["tag", "Tag"],
  ["size", "Size"],
  ["page", "Page"],
  ["floor", "Floor"],
] as const;

export default function Measurements() {
  const { pid } = useParams();
  const ws = useWorkspace(pid);
  const nav = useNavigate();
  const [tab, setTab] = useState<"table" | "schedule">("schedule");
  const [group, setGroup] = useState("type");
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const pages = usePages(pid);
  const sched = useSchedule(pid, group, ws.unit);
  if (!pid) return null;
  const openings = ws.openings.data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Measurements")}</h1>
          <p className="muted">
            {ws.project.data?.name} · {tp(sched.data?.total_openings ?? 0, "{n} opening", "{n} openings")} · {t("{n} unverified", { n: sched.data?.unverified_count ?? 0 })}
          </p>
        </div>
        <div className="row gap">
          <UnitSwitch unit={ws.unit} onChange={ws.setUnit} />
          <button className="btn btn-primary btn-lg" onClick={() => nav(`/p/${pid}/print?group=${group}&unit=${ws.unit}`)}>
            <Printer size={16} /> {t("Print Extraction")}
          </button>
          <button className="btn btn-lg" onClick={() => setExporting(true)}>
            <Download size={16} /> {t("Download PDF")}
          </button>
        </div>
      </div>
      {sched.data && sched.data.needs_review_count > 0 && (
        <div className="banner banner-warn">
          {t("{n} opening type(s) still need review. They are included and marked in exports.", { n: sched.data.needs_review_count })}{" "}
          <button className="linkish" onClick={() => nav(`/p/${pid}/review`)}>
            {t("Review them →")}
          </button>
        </div>
      )}
      <div className="tabs">
        <button className={tab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}>
          {t("Measurement schedule")}
        </button>
        <button className={tab === "table" ? "active" : ""} onClick={() => setTab("table")}>
          {t("Extraction table")}
        </button>
      </div>
      {tab === "schedule" ? (
        <div className="card">
          <div className="row gap wrap">
            <span className="small muted">{t("Group by")}</span>
            <div className="seg">
              {GROUPS.map(([k, label]) => (
                <button key={k} className={group === k ? "active" : ""} onClick={() => setGroup(k)}>
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
          {sched.data ? <ScheduleView schedule={sched.data} /> : <div className="muted">{t("Loading…")}</div>}
        </div>
      ) : (
        <div className="card no-pad">
          <OpeningTable
            projectId={pid}
            openings={openings}
            thresholds={ws.thresholds}
            unit={ws.unit}
            onSelect={(id) => nav(`/p/${pid}/extraction?opening=${id}`)}
            canEdit={ws.canEdit}
            onAdd={() => setAdding(true)}
          />
        </div>
      )}
      {exporting && <ExportDialog projectId={pid} unit={ws.unit} group={group} info={ws.project.data?.info ?? {}} canEdit={ws.canEdit} onClose={() => setExporting(false)} />}
      {adding && <AddOpeningModal projectId={pid} pages={pages.data ?? []} onClose={() => setAdding(false)} onCreated={() => setAdding(false)} />}
    </div>
  );
}

function ExportDialog({ projectId, unit, group, info, canEdit, onClose }: { projectId: string; unit: DisplayUnit; group: string; info: ProjectInfo; canEdit: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<"summary" | "detailed">("summary");
  const [size, setSize] = useState("A4");
  const [orientation, setOrientation] = useState("portrait");
  const [includeUnverified, setIncludeUnverified] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [pi, setPi] = useState<ProjectInfo>({ date: new Date().toISOString().slice(0, 10), ...info });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!info.date) setPi((x) => ({ ...x, date: new Date().toISOString().slice(0, 10) }));
  }, [info.date]);
  const set = (k: keyof ProjectInfo) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setPi({ ...pi, [k]: e.target.value });

  const go = async () => {
    setBusy(true);
    try {
      await downloadBlob(
        `/api/projects/${projectId}/export/pdf`,
        { kind, page_size: size, orientation, group_by: group, unit, include_unverified: includeUnverified, include_notes: includeNotes, info: pi },
        `measurement_schedule_${kind}.pdf`,
      );
      qc.invalidateQueries({ queryKey: qk.project(projectId) });
      toast(t("PDF saved"));
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("Download PDF")} onClose={onClose} wide>
      <div className="form">
        <div className="grid2">
          <fieldset>
            <legend>{t("Report")}</legend>
            <label className="radio">
              <input type="radio" checked={kind === "summary"} onChange={() => setKind("summary")} /> <b>{t("Summary")}</b> — {t("project info, schedules, dimensions, quantities, drawing references")}
            </label>
            <label className="radio">
              <input type="radio" checked={kind === "detailed"} onChange={() => setKind("detailed")} /> <b>{t("Detailed")}</b> — {t("plus a crop of the source drawing for every opening with the opening and its dimension highlighted")}
            </label>
          </fieldset>
          <fieldset>
            <legend>{t("Page")}</legend>
            <div className="row gap">
              <select value={size} onChange={(e) => setSize(e.target.value)} aria-label={t("Page size")}>
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="LETTER">{t("Letter")}</option>
              </select>
              <select value={orientation} onChange={(e) => setOrientation(e.target.value)} aria-label={t("Orientation")}>
                <option value="portrait">{t("Portrait")}</option>
                <option value="landscape">{t("Landscape")}</option>
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={includeUnverified} onChange={(e) => setIncludeUnverified(e.target.checked)} /> {t("Include unverified items (marked in the status column)")}
            </label>
            <label className="check">
              <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> {t("Include notes")}
            </label>
          </fieldset>
        </div>
        <fieldset>
          <legend>{t("Project information (shown in the PDF header)")}</legend>
          <div className="grid2">
            <label>
              {t("Project name")}
              <input value={pi.project_name ?? ""} onChange={set("project_name")} />
            </label>
            <label>
              {t("Drawing set name")}
              <input value={pi.drawing_set_name ?? ""} onChange={set("drawing_set_name")} />
            </label>
            <label>
              {t("Project address")}
              <input value={pi.project_address ?? ""} onChange={set("project_address")} />
            </label>
            <label>
              {t("Prepared by")}
              <input value={pi.prepared_by ?? ""} onChange={set("prepared_by")} />
            </label>
            <label>
              {t("Date")}
              <input type="date" value={pi.date ?? ""} onChange={set("date")} />
            </label>
            <label className="span2">
              {t("Notes")}
              <textarea rows={2} value={pi.notes ?? ""} onChange={set("notes")} />
            </label>
          </div>
          {canEdit && <div className="small muted">{t("These details are saved with the project.")}</div>}
        </fieldset>
        <p className="small muted">{t("The PDF is generated from the current, reviewed values — including every edit you have made.")}</p>
        <button className="btn btn-primary" onClick={go} disabled={busy}>
          <Download size={15} /> {busy ? t("Generating…") : kind === "summary" ? t("Download summary PDF") : t("Download detailed PDF")}
        </button>
      </div>
    </Modal>
  );
}

export async function saveProjectInfo(projectId: string, info: ProjectInfo) {
  return api(`/api/projects/${projectId}`, { method: "PATCH", body: { info } });
}
