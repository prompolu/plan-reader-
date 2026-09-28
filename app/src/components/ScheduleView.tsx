import type { Schedule } from "../api/types";

export default function ScheduleView({ schedule, showNotes = true, showStatus = true }: { schedule: Schedule; showNotes?: boolean; showStatus?: boolean }) {
  return (
    <div className="schedule">
      {schedule.groups.map((g) => (
        <section key={g.key} className="sched-group">
          <h3>{g.title}</h3>
          <table className="sched-table">
            <colgroup>
              <col style={{ width: "8%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "14%" }} />
              {showStatus && <col style={{ width: "10%" }} />}
              {showNotes && <col />}
            </colgroup>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Type</th>
                <th className="r">Width</th>
                <th className="r">Height</th>
                <th className="r">Qty</th>
                <th>Drawing ref</th>
                <th>Floor</th>
                {showStatus && <th>Status</th>}
                {showNotes && <th>Notes</th>}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={`${r.id}-${r.drawing_reference}`}>
                  <td className="b">{r.tag}</td>
                  <td>{r.type_label}</td>
                  <td className={`r ${r.width_status === "conflict" ? "t-conflict wrap" : r.width_status === "missing" ? "t-missing" : ""}`}>{r.width}</td>
                  <td className={`r ${r.height_status === "conflict" ? "t-conflict wrap" : r.height_status === "missing" ? "t-missing" : ""}`}>{r.height}</td>
                  <td className="r b">{r.quantity}</td>
                  <td className="wrap">{r.drawing_reference}</td>
                  <td className="wrap">{r.floor}</td>
                  {showStatus && <td className={r.verified ? "t-ok" : r.status === "needs_review" ? "t-warn" : "muted"}>{r.verified ? "Verified" : r.status === "needs_review" ? "Needs review" : "Unverified"}</td>}
                  {showNotes && <td className="small wrap">{r.notes}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="r muted">
                  Total
                </td>
                <td className="r b">{g.total_quantity}</td>
                <td colSpan={2 + (showStatus ? 1 : 0) + (showNotes ? 1 : 0)} />
              </tr>
            </tfoot>
          </table>
        </section>
      ))}
      {schedule.has_inferred && <p className="small muted">* Inferred from the drawing scale – not an explicitly dimensioned value.</p>}
    </div>
  );
}
