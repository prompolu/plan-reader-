import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BBox, Opening, PageInfo } from "../api/types";
import { useInvalidateProject, useSystem } from "../hooks/data";
import { Modal, useToast } from "./ui";

export default function AddOpeningModal({
  projectId,
  pages,
  defaultPage,
  bbox,
  onClose,
  onCreated,
}: {
  projectId: string;
  pages: PageInfo[];
  defaultPage?: number | null;
  bbox?: BBox | null;
  onClose: () => void;
  onCreated: (o: Opening) => void;
}) {
  const system = useSystem();
  const toast = useToast();
  const invalidate = useInvalidateProject();
  useQueryClient();
  const [f, setF] = useState({ type: "window", tag: "", width: "", height: "", quantity: "1", page_index: defaultPage != null ? String(defaultPage) : "", floor: "", room: "", notes: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const page = pages.find((p) => String(p.page_index) === f.page_index);
    try {
      const o = await api<Opening>(`/api/projects/${projectId}/openings`, {
        method: "POST",
        body: {
          type: f.type,
          tag: f.tag || null,
          width: f.width ? { text: f.width } : null,
          height: f.height ? { text: f.height } : null,
          quantity: f.quantity === "" ? null : Number(f.quantity),
          page_index: page ? page.page_index : null,
          drawing_reference: page?.sheet_number ?? null,
          floor: f.floor || page?.floor || null,
          room: f.room || null,
          notes: f.notes || null,
          bbox: bbox ?? null,
        },
      });
      invalidate(projectId);
      toast(`${o.tag || o.ref} added`);
      onCreated(o);
    } catch (ex) {
      toast((ex as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add opening manually" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small muted">Manual entries are stored as user-sourced values{bbox ? " at the area you drew on the drawing" : ""}.</p>
        <div className="grid2">
          <label>
            Type
            <select value={f.type} onChange={set("type")}>
              {Object.entries(system.data?.opening_types ?? { window: "Window", door: "Door" }).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tag
            <input value={f.tag} onChange={set("tag")} placeholder="e.g. W-12" />
          </label>
          <label>
            Width
            <input value={f.width} onChange={set("width")} placeholder={`1200 or 4'-0"`} />
          </label>
          <label>
            Height
            <input value={f.height} onChange={set("height")} placeholder={`1500 or 5'-0"`} />
          </label>
          <label>
            Quantity
            <input type="number" min={0} value={f.quantity} onChange={set("quantity")} />
          </label>
          <label>
            Page
            <select value={f.page_index} onChange={set("page_index")}>
              <option value="">—</option>
              {pages.map((p) => (
                <option key={p.id} value={p.page_index}>
                  {p.page}. {p.sheet_number ?? ""} {p.page_type_label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Floor
            <input value={f.floor} onChange={set("floor")} />
          </label>
          <label>
            Room
            <input value={f.room} onChange={set("room")} />
          </label>
          <label className="span2">
            Notes
            <textarea rows={2} value={f.notes} onChange={set("notes")} />
          </label>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Add opening
        </button>
      </form>
    </Modal>
  );
}
