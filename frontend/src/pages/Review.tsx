import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, PartyPopper, XCircle } from "lucide-react";
import DrawingViewer from "../components/DrawingViewer";
import OpeningDetails from "../components/OpeningDetails";
import { Empty, useToast } from "../components/ui";
import { useOpeningMutation, useReview, useSystem } from "../hooks/data";
import { useWorkspace } from "../hooks/workspace";
import { UnitSwitch } from "./Extraction";

export default function Review() {
  const { pid } = useParams();
  const ws = useWorkspace(pid);
  const review = useReview(pid);
  const system = useSystem();
  const mut = useOpeningMutation(pid ?? "");
  const toast = useToast();

  // one entry per opening, in queue order
  const queue = useMemo(() => {
    const items = review.data?.items ?? [];
    const order: string[] = [];
    const byId = new Map<string, typeof items>();
    for (const it of items) {
      if (!byId.has(it.opening_id)) {
        byId.set(it.opening_id, []);
        order.push(it.opening_id);
      }
      byId.get(it.opening_id)!.push(it);
    }
    return order.map((id) => ({ id, items: byId.get(id)! }));
  }, [review.data]);

  const pos = queue.findIndex((q) => q.id === ws.selectedId);

  useEffect(() => {
    if (!ws.selectedId && queue.length && ws.openings.data) ws.select(queue[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length, ws.openings.data]);

  if (!pid) return null;
  const pages = ws.pages.data ?? [];

  const go = (delta: number) => {
    if (!queue.length) return;
    const i = pos < 0 ? 0 : (pos + delta + queue.length) % queue.length;
    ws.select(queue[i].id);
  };

  const verifyNext = () => {
    if (!ws.selected) return;
    const cur = ws.selected.id;
    const nextId = queue.length > 1 ? queue[(pos + 1) % queue.length].id : null;
    mut.mutate(
      { id: cur, path: "/verify", method: "POST", body: { verified: true } },
      {
        onSuccess: () => {
          toast(`${ws.selected?.tag || ws.selected?.ref} verified`);
          if (nextId && nextId !== cur) ws.select(nextId);
          else ws.select(null);
        },
        onError: (e) => toast((e as Error).message, "error"),
      },
    );
  };

  const counts = (review.data?.items ?? []).reduce<Record<string, number>>((m, i) => ({ ...m, [i.label]: (m[i.label] ?? 0) + 1 }), {});

  return (
    <div className="workspace">
      <div className="ws-head">
        <div>
          <h2>Needs review — {queue.length} item{queue.length === 1 ? "" : "s"}</h2>
          <span className="muted small">
            {Object.entries(counts)
              .map(([k, v]) => `${v} × ${k}`)
              .join(" · ") || "Nothing flagged"}
          </span>
        </div>
        <div className="row gap">
          <UnitSwitch unit={ws.unit} onChange={ws.setUnit} />
          <button className="btn btn-sm" onClick={() => go(-1)} disabled={queue.length < 2}>
            <ChevronLeft size={14} /> Previous
          </button>
          <button className="btn btn-sm" onClick={() => go(1)} disabled={queue.length < 2}>
            Skip <ChevronRight size={14} />
          </button>
          {ws.canEdit && (
            <button className="btn btn-sm btn-primary" onClick={verifyNext} disabled={!ws.selected || pos < 0}>
              <CheckCircle2 size={14} /> Verify & next
            </button>
          )}
        </div>
      </div>
      {review.isSuccess && queue.length === 0 ? (
        <div className="page">
          <Empty icon={<PartyPopper size={36} />} title="Nothing needs review">
            <p className="muted">Every flagged opening has been verified or resolved.</p>
          </Empty>
        </div>
      ) : (
        <div className="ws-body review-body">
          <aside className="queue">
            {queue.map((q, i) => {
              const o = ws.openings.data?.find((x) => x.id === q.id);
              return (
                <button key={q.id} className={`queue-item ${q.id === ws.selectedId ? "sel" : ""}`} onClick={() => ws.select(q.id)}>
                  <div className="row between">
                    <b>{o?.tag || q.items[0].ref}</b>
                    <span className="muted small">
                      {i + 1}/{queue.length}
                    </span>
                  </div>
                  {q.items.map((it, j) => (
                    <div key={j} className={`small qi-${it.severity}`}>
                      {it.severity === "error" ? <XCircle size={12} /> : <AlertTriangle size={12} />} {it.label}
                    </div>
                  ))}
                </button>
              );
            })}
          </aside>
          <div className="ws-left">
            <div className="ws-viewer tall">
              <DrawingViewer
                projectId={pid}
                page={ws.page}
                pages={pages}
                onPageChange={ws.setPageIndex}
                overlay={ws.overlay.data}
                openings={ws.openings.data ?? []}
                selectedId={ws.selectedId}
                onSelect={(id) => ws.select(id, false)}
                focus={ws.focus}
                thresholds={ws.thresholds}
                extra={ws.extra}
              />
            </div>
          </div>
          <aside className="ws-right">
            {ws.selected ? (
              <OpeningDetails
                projectId={pid}
                opening={ws.selected}
                thresholds={ws.thresholds}
                unit={ws.unit}
                pages={pages}
                canEdit={ws.canEdit}
                onNavigate={ws.goTo}
                onDeleted={() => go(1)}
                openingTypes={system.data?.opening_types ?? {}}
              />
            ) : (
              <div className="tab-body muted">Select an item from the queue.</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
