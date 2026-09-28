import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Search } from "lucide-react";
import type { DisplayUnit, Measurement, Opening, Thresholds } from "../api/types";
import { useOpeningMutation } from "../hooks/data";
import { formatLength, UNIT_LABELS } from "../lib/units";
import { ConfidenceBadge, StatusBadge, useToast } from "./ui";

type SortKey = "tag" | "type" | "width" | "height" | "page" | "confidence" | "qty";
type TypeFilter = "all" | "windows" | "doors" | "sliding" | "other";
type StatusFilter = "all" | "verified" | "needs_review" | "inferred" | "unverified";
type GroupBy = "none" | "type" | "floor" | "page";

const WINDOWS = new Set(["window", "sliding_window", "curtain_wall"]);
const DOORS = new Set(["door", "double_door", "garage_door"]);

function natural(tag: string | null): [string, number, string] {
  if (!tag) return ["~", 1e9, ""];
  const m = tag.match(/^([A-Za-z]+)\D*(\d+)(.*)$/);
  return m ? [m[1].toUpperCase(), Number(m[2]), m[3]] : [tag, 0, ""];
}

function mv(m: Measurement | null): number {
  return m && m.value !== null ? m.value : -1;
}

interface Props {
  projectId: string;
  openings: Opening[];
  thresholds: Thresholds;
  unit: DisplayUnit;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  canEdit: boolean;
  onAdd?: () => void;
  compact?: boolean;
}

export default function OpeningTable(p: Props) {
  const [q, setQ] = useState("");
  const [tf, setTf] = useState<TypeFilter>("all");
  const [sf, setSf] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "tag", dir: 1 });
  const [group, setGroup] = useState<GroupBy>("none");
  const [edit, setEdit] = useState<{ id: string; field: "tag" | "width" | "height" | "quantity"; value: string } | null>(null);
  const mut = useOpeningMutation(p.projectId);
  const toast = useToast();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = p.openings.filter((o) => {
      if (needle) {
        const hay = [o.tag, o.ref, o.type_label, o.drawing_reference, o.floor, o.room, o.notes].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (tf === "windows" && !WINDOWS.has(o.type)) return false;
      if (tf === "doors" && !DOORS.has(o.type)) return false;
      if (tf === "sliding" && o.type !== "sliding_door") return false;
      if (tf === "other" && (WINDOWS.has(o.type) || DOORS.has(o.type) || o.type === "sliding_door")) return false;
      if (sf === "verified" && !o.verification.verified) return false;
      if (sf === "unverified" && o.verification.verified) return false;
      if (sf === "needs_review" && o.status !== "needs_review") return false;
      if (sf === "inferred" && !(o.width?.status === "inferred" || o.height?.status === "inferred")) return false;
      return true;
    });
    const cmp = (a: Opening, b: Opening): number => {
      switch (sort.key) {
        case "tag": {
          const x = natural(a.tag);
          const y = natural(b.tag);
          return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2].localeCompare(y[2]);
        }
        case "type":
          return a.type_label.localeCompare(b.type_label);
        case "width":
          return mv(a.width) - mv(b.width);
        case "height":
          return mv(a.height) - mv(b.height);
        case "page":
          return (a.page_index ?? 1e9) - (b.page_index ?? 1e9);
        case "qty":
          return (a.quantity ?? 0) - (b.quantity ?? 0);
        case "confidence":
          return (a.confidence.overall ?? 0) - (b.confidence.overall ?? 0);
      }
    };
    r = [...r].sort((a, b) => cmp(a, b) * sort.dir);
    return r;
  }, [p.openings, q, tf, sf, sort]);

  const groups = useMemo(() => {
    if (group === "none") return [{ key: "all", title: "", rows }];
    const map = new Map<string, Opening[]>();
    for (const o of rows) {
      const k = group === "type" ? o.type_label : group === "floor" ? o.floor || "Floor not identified" : o.drawing_reference || "No page";
      map.set(k, [...(map.get(k) ?? []), o]);
    }
    return [...map.entries()].map(([k, v]) => ({ key: k, title: k, rows: v }));
  }, [rows, group]);

  const header = (key: SortKey, label: string, cls = "") => (
    <th className={cls} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {label}
      {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </th>
  );

  const commit = () => {
    if (!edit) return;
    const o = p.openings.find((x) => x.id === edit.id);
    if (!o) return setEdit(null);
    let changes: Record<string, unknown>;
    if (edit.field === "quantity") changes = { quantity: edit.value === "" ? null : Number(edit.value) };
    else if (edit.field === "tag") changes = { tag: edit.value || null };
    else changes = { [edit.field]: edit.value.trim() ? { text: edit.value.trim() } : null };
    mut.mutate({ id: o.id, body: { changes, version: o.version } }, { onSuccess: () => toast("Saved"), onError: (e) => toast((e as Error).message, "error") });
    setEdit(null);
  };

  const cell = (o: Opening, field: "tag" | "width" | "height" | "quantity", display: React.ReactNode, initial: string) => {
    if (edit && edit.id === o.id && edit.field === field)
      return (
        <input
          className="cell-input"
          autoFocus
          value={edit.value}
          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEdit(null);
          }}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
        />
      );
    return (
      <span
        className={p.canEdit ? "editable" : ""}
        title={p.canEdit ? "Double-click to edit" : undefined}
        onDoubleClick={(e) => {
          if (!p.canEdit) return;
          e.stopPropagation();
          setEdit({ id: o.id, field, value: initial });
        }}
      >
        {display}
      </span>
    );
  };

  const meas = (m: Measurement | null) => {
    if (!m) return <span className="t-missing">Needs review</span>;
    if (m.status === "conflict") return <span className="t-conflict">Conflict</span>;
    const v = formatLength(m.value, p.unit, m.original_text, false);
    return (
      <span className={m.status === "inferred" ? "t-inferred" : m.source === "user" ? "t-user" : ""} title={m.status === "inferred" ? "Inferred from drawing scale" : m.source === "user" ? "Entered by user" : `From drawing: “${m.original_text}”`}>
        {v}
        {m.status === "inferred" ? "*" : ""}
      </span>
    );
  };

  return (
    <div className={`otable ${p.compact ? "compact" : ""}`}>
      <div className="otable-tools">
        <div className="search">
          <Search size={14} />
          <input placeholder="Search tag, type, page…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search openings" />
        </div>
        <select value={tf} onChange={(e) => setTf(e.target.value as TypeFilter)} aria-label="Type filter">
          <option value="all">All types</option>
          <option value="windows">Windows</option>
          <option value="doors">Doors</option>
          <option value="sliding">Sliding doors</option>
          <option value="other">Other</option>
        </select>
        <select value={sf} onChange={(e) => setSf(e.target.value as StatusFilter)} aria-label="Status filter">
          <option value="all">All statuses</option>
          <option value="verified">Verified</option>
          <option value="needs_review">Needs review</option>
          <option value="inferred">Inferred</option>
          <option value="unverified">Unverified</option>
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value as GroupBy)} aria-label="Group by">
          <option value="none">No grouping</option>
          <option value="type">Group by type</option>
          <option value="floor">Group by floor</option>
          <option value="page">Group by page</option>
        </select>
        <span className="muted small grow">
          {rows.length} of {p.openings.length} · {rows.reduce((n, o) => n + (o.quantity ?? 0), 0)} openings
        </span>
        {p.canEdit && p.onAdd && (
          <button className="btn btn-sm" onClick={p.onAdd}>
            <Plus size={14} /> Add opening manually
          </button>
        )}
      </div>
      <div className="otable-scroll">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              {header("type", "Type")}
              {header("tag", "Tag")}
              {header("width", "Width", "r")}
              {header("height", "Height", "r")}
              <th>Unit</th>
              {header("qty", "Qty", "r")}
              {header("page", "Page")}
              <th>Status</th>
              {header("confidence", "Conf.")}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows key={g.key} title={g.title}>
                {g.rows.map((o, i) => (
                  <tr key={o.id} className={o.id === p.selectedId ? "sel" : ""} onClick={() => p.onSelect(o.id)}>
                    <td className="num muted">{i + 1}</td>
                    <td>{o.type_label}</td>
                    <td className="b">{cell(o, "tag", o.tag || <span className="muted">—</span>, o.tag ?? "")}</td>
                    <td className="r">{cell(o, "width", meas(o.width), o.width?.value ? (o.width.original_text ?? String(Math.round(o.width.value))) : "")}</td>
                    <td className="r">{cell(o, "height", meas(o.height), o.height?.value ? (o.height.original_text ?? String(Math.round(o.height.value))) : "")}</td>
                    <td className="muted">{UNIT_LABELS[p.unit]}</td>
                    <td className="r b">{cell(o, "quantity", o.quantity ?? "—", o.quantity === null ? "" : String(o.quantity))}</td>
                    <td>{o.drawing_reference ?? (o.page ? `p.${o.page}` : "—")}</td>
                    <td>
                      <StatusBadge o={o} />
                    </td>
                    <td>
                      <ConfidenceBadge value={o.confidence.overall} t={p.thresholds} />
                    </td>
                  </tr>
                ))}
              </GroupRows>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="muted center">
                  No openings match the filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      {title && (
        <tr className="group-row">
          <td colSpan={10}>{title}</td>
        </tr>
      )}
      {children}
    </>
  );
}
