import type { Schedule } from "../api/types";
import { t } from "../i18n";

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
                <th>{t("Tag")}</th>
                <th>{t("Type")}</th>
                <th className="r">{t("Width")}</th>
                <th className="r">{t("Height")}</th>
                <th className="r">{t("Qty")}</th>
                <th>{t("Drawing ref")}</th>
                <th>{t("Floor")}</th>
                {showStatus && <th>{t("Status")}</th>}
                {showNotes && <th>{t("Notes")}</th>}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={`${r.id}-${r.drawing_reference}`}>
                  {/* s-* classes and data-label: on phones each row is laid out as a block with labelled values */}
                  <td className="b s-tag">{r.tag}</td>
                  <td className="s-type">{r.type_label}</td>
                  <td data-label={t("Width")} className={`r s-w ${r.width_status === "conflict" ? "t-conflict wrap" : r.width_status === "missing" ? "t-missing" : ""}`}>
                    {r.width}
                  </td>
                  <td data-label={t("Height")} className={`r s-h ${r.height_status === "conflict" ? "t-conflict wrap" : r.height_status === "missing" ? "t-missing" : ""}`}>
                    {r.height}
                  </td>
                  <td data-label={t("Qty")} className="r b s-qty">
                    {r.quantity}
                  </td>
                  <td data-label={t("Drawing ref")} className="wrap s-ref">
                    {r.drawing_reference}
                  </td>
                  <td data-label={t("Floor")} className="wrap s-floor">
                    {r.floor}
                  </td>
                  {showStatus && (
                    <td className={`s-status ${r.verified ? "t-ok" : r.status === "needs_review" ? "t-warn" : "muted"}`}>
                      {r.verified ? t("Verified") : r.status === "needs_review" ? t("Needs review") : t("Unverified")}
                    </td>
                  )}
                  {showNotes && (
                    <td data-label={t("Notes")} className="small wrap s-notes">
                      {r.notes}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="r muted s-total">
                  {t("Total")}
                </td>
                <td className="r b s-qty">{g.total_quantity}</td>
                <td className="s-rest" colSpan={2 + (showStatus ? 1 : 0) + (showNotes ? 1 : 0)} />
              </tr>
            </tfoot>
          </table>
        </section>
      ))}
      {schedule.has_inferred && <p className="small muted">* {t("Inferred from the drawing scale – not an explicitly dimensioned value.")}</p>}
    </div>
  );
}
