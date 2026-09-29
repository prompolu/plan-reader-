import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2, SquareDashedMousePointer, UploadCloud } from "lucide-react";
import type { BBox, DisplayUnit } from "../api/types";
import AddOpeningModal from "../components/AddOpeningModal";
import DrawingViewer from "../components/DrawingViewer";
import OpeningDetails from "../components/OpeningDetails";
import OpeningTable from "../components/OpeningTable";
import PagePanel from "../components/PagePanel";
import { Empty } from "../components/ui";
import { useJobs, useSystem } from "../hooks/data";
import { useWorkspace } from "../hooks/workspace";
import { UNIT_LABELS } from "../lib/units";
import { t, tp } from "../i18n";

export function UnitSwitch({ unit, onChange }: { unit: DisplayUnit; onChange: (u: DisplayUnit) => void }) {
  return (
    <div className="seg" role="group" aria-label={t("Display unit")}>
      {(Object.keys(UNIT_LABELS) as DisplayUnit[]).map((u) => (
        <button key={u} className={u === unit ? "active" : ""} onClick={() => onChange(u)}>
          {UNIT_LABELS[u]}
        </button>
      ))}
    </div>
  );
}

export default function Extraction() {
  const { pid } = useParams();
  const ws = useWorkspace(pid);
  const system = useSystem();
  const jobs = useJobs(pid, true);
  const job = jobs.data?.[0];
  const [side, setSide] = useState<"opening" | "page">("opening");
  const [adding, setAdding] = useState<{ bbox: BBox | null } | null>(null);
  const [drawMode, setDrawMode] = useState(false);

  if (!pid) return null;
  const pages = ws.pages.data ?? [];
  const openings = ws.openings.data ?? [];
  const busy = job && ["queued", "running"].includes(job.status);

  if (ws.pages.isSuccess && pages.length === 0) {
    return (
      <div className="page">
        <Empty icon={<UploadCloud size={36} />} title={t("No drawings in this project yet")}>
          {busy ? (
            <p>
              <Loader2 size={14} className="spin" /> {job?.message}
            </p>
          ) : (
            <Link className="btn btn-primary" to={`/p/${pid}/upload`}>
              {t("Upload plans")}
            </Link>
          )}
        </Empty>
      </div>
    );
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <div>
          <h2>{ws.project.data?.name}</h2>
          <span className="muted small">
            {tp(pages.length, "{n} page", "{n} pages")} · {tp(openings.length, "{n} opening type", "{n} opening types")} · {tp(openings.reduce((n, o) => n + (o.quantity ?? 0), 0), "{n} opening", "{n} openings")} ·{" "}
            {tp(openings.filter((o) => o.status === "needs_review").length, "{n} needs review", "{n} need review")}
          </span>
        </div>
        <div className="row gap">
          {busy && (
            <Link to={`/p/${pid}/upload`} className="badge badge-blue">
              <Loader2 size={12} className="spin" /> {job?.message}
            </Link>
          )}
          <UnitSwitch unit={ws.unit} onChange={ws.setUnit} />
          {ws.canEdit && (
            <button className={`btn btn-sm ${drawMode ? "btn-primary" : ""}`} onClick={() => setDrawMode((v) => !v)} title={t("Draw a box on the drawing to add an opening manually")}>
              <SquareDashedMousePointer size={14} /> {drawMode ? t("Drawing… (drag on the plan)") : t("Mark opening")}
            </button>
          )}
        </div>
      </div>
      <div className="ws-body">
        <div className="ws-left">
          <div className="ws-viewer">
            <DrawingViewer
              projectId={pid}
              page={ws.page}
              pages={pages}
              onPageChange={ws.setPageIndex}
              overlay={ws.overlay.data}
              openings={openings}
              selectedId={ws.selectedId}
              onSelect={(id) => {
                ws.select(id, false);
                setSide("opening");
              }}
              focus={ws.focus}
              thresholds={ws.thresholds}
              extra={ws.extra}
              drawMode={drawMode}
              onBoxDrawn={(bbox) => {
                setDrawMode(false);
                setAdding({ bbox });
              }}
            />
          </div>
          <div className="ws-table">
            <OpeningTable
              projectId={pid}
              openings={openings}
              thresholds={ws.thresholds}
              unit={ws.unit}
              selectedId={ws.selectedId}
              onSelect={(id) => {
                ws.select(id);
                setSide("opening");
              }}
              canEdit={ws.canEdit}
              onAdd={() => setAdding({ bbox: null })}
              compact
            />
          </div>
        </div>
        <aside className="ws-right">
          <div className="tabs tabs-top">
            <button className={side === "opening" ? "active" : ""} onClick={() => setSide("opening")}>
              {t("Opening")}
            </button>
            <button className={side === "page" ? "active" : ""} onClick={() => setSide("page")}>
              {t("Page & scale")}
            </button>
          </div>
          {side === "page" ? (
            ws.page ? (
              <PagePanel projectId={pid} page={ws.page} canEdit={ws.canEdit} />
            ) : null
          ) : ws.selected ? (
            <OpeningDetails
              projectId={pid}
              opening={ws.selected}
              thresholds={ws.thresholds}
              unit={ws.unit}
              pages={pages}
              canEdit={ws.canEdit}
              onNavigate={ws.goTo}
              onDeleted={() => ws.select(null)}
              openingTypes={system.data?.opening_types ?? {}}
            />
          ) : (
            <div className="tab-body muted">
              <p>{t("Select an opening in the table or on the drawing to see its measurements, evidence and history.")}</p>
              <p className="small">{t("Coloured boxes show detected openings: green = high confidence or verified, yellow = review recommended, red = low confidence. Dashed boxes are references (elevations, details) that are not counted again.")}</p>
            </div>
          )}
        </aside>
      </div>
      {adding && (
        <AddOpeningModal
          projectId={pid}
          pages={pages}
          defaultPage={ws.pageIndex}
          bbox={adding.bbox}
          onClose={() => setAdding(null)}
          onCreated={(o) => {
            setAdding(null);
            ws.select(o.id, false);
          }}
        />
      )}
    </div>
  );
}
