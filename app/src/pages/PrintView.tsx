import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import type { DisplayUnit } from "../api/types";
import ScheduleView from "../components/ScheduleView";
import { useProject, useSchedule } from "../hooks/data";

/** Printer-friendly measurement schedule (browser print, @page size/orientation). */
export default function PrintView() {
  const { pid } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const project = useProject(pid);
  const size = params.get("size") ?? "A4";
  const orientation = params.get("orientation") ?? "portrait";
  const group = params.get("group") ?? "type";
  const unit = (params.get("unit") ?? "mm") as DisplayUnit;
  const [notes, setNotes] = useState(params.get("notes") !== "0");
  const [includeUnverified, setIncludeUnverified] = useState(true);
  const sched = useSchedule(pid, group, unit, includeUnverified);
  const info = project.data?.info ?? {};

  useEffect(() => {
    const el = document.createElement("style");
    const pageSize = size === "LETTER" ? "letter" : size;
    el.textContent = `@page { size: ${pageSize} ${orientation}; margin: 14mm 12mm; }`;
    document.head.appendChild(el);
    document.title = `${info.project_name || project.data?.name || "Project"} – Measurement schedule`;
    return () => el.remove();
  }, [size, orientation, info.project_name, project.data?.name]);

  const upd = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };

  return (
    <div className={`print-page ${orientation}`}>
      <div className="print-toolbar no-print">
        <button className="btn" onClick={() => (window.history.length > 1 ? nav(-1) : nav(`/p/${pid}/measurements`))}>
          <ArrowLeft size={15} /> Back
        </button>
        <select value={size} onChange={(e) => upd("size", e.target.value)} aria-label="Paper size">
          <option value="A4">A4</option>
          <option value="A3">A3</option>
          <option value="LETTER">Letter</option>
        </select>
        <select value={orientation} onChange={(e) => upd("orientation", e.target.value)} aria-label="Orientation">
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
        <select value={group} onChange={(e) => upd("group", e.target.value)} aria-label="Group by">
          <option value="type">Group by type</option>
          <option value="tag">By tag</option>
          <option value="size">By size</option>
          <option value="page">By page</option>
          <option value="floor">By floor</option>
        </select>
        <select value={unit} onChange={(e) => upd("unit", e.target.value)} aria-label="Unit">
          <option value="mm">mm</option>
          <option value="cm">cm</option>
          <option value="m">m</option>
          <option value="ft_in">ft-in</option>
          <option value="original">Original notation</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Notes
        </label>
        <label className="check">
          <input type="checkbox" checked={includeUnverified} onChange={(e) => setIncludeUnverified(e.target.checked)} /> Unverified items
        </label>
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </button>
      </div>
      <div className={`print-sheet size-${size} ${orientation}`}>
        <header className="print-header">
          <div>
            <h1>{info.project_name || project.data?.name}</h1>
            <div>{info.drawing_set_name}</div>
          </div>
          <div className="r">
            <div>Measurement Schedule</div>
            <div>{info.date || new Date().toISOString().slice(0, 10)}</div>
          </div>
        </header>
        <table className="print-info">
          <tbody>
            {info.project_address && (
              <tr>
                <th>Project address</th>
                <td>{info.project_address}</td>
              </tr>
            )}
            {info.prepared_by && (
              <tr>
                <th>Prepared by</th>
                <td>{info.prepared_by}</td>
              </tr>
            )}
            {notes && info.notes && (
              <tr>
                <th>Notes</th>
                <td className="pre">{info.notes}</td>
              </tr>
            )}
          </tbody>
        </table>
        {sched.data && (
          <>
            <p className="small">
              {sched.data.total_openings} openings. Dimensions in {unit === "ft_in" ? "feet and inches" : unit === "original" ? "original drawing notation" : unit}.
              {sched.data.unverified_count > 0 && ` ${sched.data.unverified_count} item(s) not yet verified.`}
            </p>
            <ScheduleView schedule={sched.data} showNotes={notes} />
          </>
        )}
        <footer className="print-footer small">Generated by PlanMeasure AI from the current reviewed data · {new Date().toLocaleString()}</footer>
      </div>
    </div>
  );
}
