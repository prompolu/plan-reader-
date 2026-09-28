import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Expand, Layers, Maximize, Minimize, Search, ZoomIn, ZoomOut, X } from "lucide-react";
import type { BBox, Opening, Overlay, PageInfo, Seg, Thresholds } from "../api/types";
import { api } from "../api/client";
import { band, BAND_COLORS } from "../lib/confidence";

export interface Focus {
  bbox: BBox;
  key: string;
}

export interface ExtraHighlight {
  bbox?: BBox | null;
  line?: Seg | null;
  color: string;
  label?: string;
}

interface Props {
  projectId: string;
  page: PageInfo | undefined;
  pages: PageInfo[];
  onPageChange: (pageIndex: number) => void;
  overlay?: Overlay;
  openings: Opening[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  focus?: Focus | null;
  thresholds: Thresholds;
  extra?: ExtraHighlight[];
  onBoxDrawn?: (bbox: BBox) => void; // "draw a box" mode for manual openings
  drawMode?: boolean;
}

interface View {
  s: number;
  tx: number;
  ty: number;
}

const MIN_S = 0.05;
const MAX_S = 40;

export default function DrawingViewer(props: Props) {
  const { page, pages, overlay, openings, selectedId, thresholds } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ s: 0.5, tx: 0, ty: 0 });
  const [layers, setLayers] = useState({ openings: true, references: true, dimensions: false, detections: false });
  const [showLayers, setShowLayers] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hires, setHires] = useState<{ url: string; x: number; y: number; w: number; h: number; page: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ page_index: number; sheet: string | null; text: string; bbox: BBox }[]>([]);
  const [activeHit, setActiveHit] = useState<{ page_index: number; bbox: BBox } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; draw?: { x: number; y: number } } | null>(null);
  const [drawBox, setDrawBox] = useState<BBox | null>(null);
  const lastFit = useRef<string>("");

  // container size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!page) return;
    const s = Math.min(size.w / page.width, size.h / page.height) * 0.96;
    setView({ s, tx: (size.w - page.width * s) / 2, ty: (size.h - page.height * s) / 2 });
  }, [page, size]);

  const zoomTo = useCallback(
    (b: BBox) => {
      const pad = Math.max(b.width, b.height) * 1.6 + 30;
      const s = Math.min(MAX_S, Math.min(size.w / (b.width + 2 * pad), size.h / (b.height + 2 * pad)));
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      setView({ s, tx: size.w / 2 - cx * s, ty: size.h / 2 - cy * s });
    },
    [size],
  );

  // fit when the page changes (unless a focus target is pending)
  useEffect(() => {
    if (!page) return;
    const key = `${page.id}:${size.w}x${size.h}`;
    if (lastFit.current.startsWith(page.id) && lastFit.current === key) return;
    const focusOnThisPage = props.focus && lastFit.current !== key;
    lastFit.current = key;
    if (!focusOnThisPage) fit();
    setHires(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id, size.w, size.h]);

  useEffect(() => {
    if (props.focus && page) zoomTo(props.focus.bbox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.key, page?.id]);

  // high-resolution region rendering when zoomed in beyond the base image resolution
  useEffect(() => {
    if (!page || !page.image_width) return;
    const dpr = window.devicePixelRatio || 1;
    const base = page.image_width / page.width;
    const need = view.s * dpr;
    if (need <= base * 1.15) {
      setHires(null);
      return;
    }
    const t = setTimeout(() => {
      const x = Math.max(0, -view.tx / view.s);
      const y = Math.max(0, -view.ty / view.s);
      const w = Math.min(page.width - x, size.w / view.s);
      const h = Math.min(page.height - y, size.h / view.s);
      if (w <= 1 || h <= 1) return;
      const scale = Math.min(need, 12);
      const url = `/api/projects/${props.projectId}/pages/${page.id}/region?x=${x.toFixed(2)}&y=${y.toFixed(2)}&w=${w.toFixed(2)}&h=${h.toFixed(2)}&scale=${scale.toFixed(3)}&t=${encodeURIComponent(page.region_token)}`;
      const img = new Image();
      img.onload = () => setHires({ url, x, y, w, h, page: page.id });
      img.src = url;
    }, 250);
    return () => clearTimeout(t);
  }, [view, page, size, props.projectId]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const s = Math.max(MIN_S, Math.min(MAX_S, v.s * f));
      const k = s / v.s;
      return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  const zoomBy = (f: number) => {
    setView((v) => {
      const s = Math.max(MIN_S, Math.min(MAX_S, v.s * f));
      const k = s / v.s;
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  const toPage = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.tx) / view.s, y: (clientY - rect.top - view.ty) / view.s };
  };

  const onPointerDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest(".viewer-toolbar, .viewer-search, .viewer-layers")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    if (props.drawMode) drag.current.draw = toPage(e.clientX, e.clientY);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.draw) {
      const p = toPage(e.clientX, e.clientY);
      setDrawBox({ x: Math.min(p.x, d.draw.x), y: Math.min(p.y, d.draw.y), width: Math.abs(p.x - d.draw.x), height: Math.abs(p.y - d.draw.y) });
      return;
    }
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.draw && drawBox && drawBox.width > 2 && drawBox.height > 2) {
      props.onBoxDrawn?.(drawBox);
    }
    setDrawBox(null);
  };

  const toggleFullscreen = () => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().then(() => setFullscreen(true));
    else document.exitFullscreen?.().then(() => setFullscreen(false));
  };
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    const res = await api<typeof hits>(`/api/projects/${props.projectId}/search?q=${encodeURIComponent(q.trim())}`);
    setHits(res);
  };

  // opening boxes on this page
  const boxes = useMemo(() => {
    if (!page) return [];
    const out: { id: string; bbox: BBox; label: string; color: string; dashed: boolean; selected: boolean }[] = [];
    for (const o of openings) {
      const selected = o.id === selectedId;
      const color = o.verification.verified ? BAND_COLORS.green : BAND_COLORS[band(o.confidence.overall, thresholds)];
      const label = o.tag || o.ref;
      let any = false;
      for (const inst of o.instances) {
        if (inst.page_index === page.page_index && layers.openings) {
          out.push({ id: o.id, bbox: inst.bbox, label, color, dashed: !!inst.geometry_missing, selected });
          any = true;
        }
      }
      for (const ref of o.references) {
        if (ref.page_index === page.page_index && layers.references) {
          out.push({ id: o.id, bbox: ref.bbox, label, color, dashed: true, selected });
          any = true;
        }
      }
      if (!any && o.page_index === page.page_index && o.bbox && layers.openings) {
        out.push({ id: o.id, bbox: o.bbox, label, color, dashed: false, selected });
      }
    }
    // draw the selected one last (on top)
    return out.sort((a, b) => Number(a.selected) - Number(b.selected));
  }, [openings, page, selectedId, thresholds, layers]);

  const selected = openings.find((o) => o.id === selectedId);
  const measureHl: ExtraHighlight[] = [];
  if (selected && page) {
    for (const f of ["width", "height"] as const) {
      const m = selected[f];
      if (!m) continue;
      if (m.status === "conflict") {
        for (const c of m.candidates ?? []) {
          if (c.page_index === page.page_index && c.bbox) measureHl.push({ bbox: c.bbox, color: "#dc2626", label: `${f}: ${c.original_text}` });
        }
      } else if (m.page_index === page.page_index) {
        measureHl.push({ bbox: m.bbox, line: m.line ?? null, color: "#1d4ed8", label: `${f}` });
        for (const e of m.extension_lines ?? []) measureHl.push({ line: e, color: "#60a5fa" });
      }
    }
  }
  const extras = [...measureHl, ...(props.extra ?? [])];
  const inv = 1 / view.s;
  const idx = pages.findIndex((p) => p.id === page?.id);

  return (
    <div className={`viewer ${fullscreen ? "is-fullscreen" : ""}`}>
      <div className="viewer-toolbar">
        <button className="icon-btn" title="Previous page" disabled={idx <= 0} onClick={() => props.onPageChange(pages[idx - 1].page_index)}>
          <ChevronLeft size={16} />
        </button>
        <select className="page-select" value={page?.page_index ?? ""} onChange={(e) => props.onPageChange(Number(e.target.value))} aria-label="Page">
          {pages.map((p) => (
            <option key={p.id} value={p.page_index}>
              {p.page}. {p.sheet_number ? `${p.sheet_number} · ` : ""}
              {p.page_type_label}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Next page" disabled={idx < 0 || idx >= pages.length - 1} onClick={() => props.onPageChange(pages[idx + 1].page_index)}>
          <ChevronRight size={16} />
        </button>
        <span className="sep" />
        <button className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
          <ZoomOut size={16} />
        </button>
        <span className="zoom-label">{Math.round((view.s * (page?.unit === "pt" ? 96 / 72 : 1)) * 100)}%</span>
        <button className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.4)}>
          <ZoomIn size={16} />
        </button>
        <button className="icon-btn" title="Fit to screen" onClick={fit}>
          <Expand size={16} />
        </button>
        <button className="icon-btn" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
        <span className="sep" />
        <button className={`icon-btn ${searchOpen ? "active" : ""}`} title="Search drawing text" onClick={() => setSearchOpen((v) => !v)}>
          <Search size={16} />
        </button>
        <button className={`icon-btn ${showLayers ? "active" : ""}`} title="Layers" onClick={() => setShowLayers((v) => !v)}>
          <Layers size={16} />
        </button>
        {page && (
          <span className="viewer-meta">
            {page.scale?.primary?.text ? `Scale ${page.scale.primary.text}${page.scale.primary.source === "manual" ? " (manual)" : page.scale.primary.source === "calibrated" ? " (calibrated)" : ""}` : "Scale not detected"}
            {page.quality?.poor ? " · ⚠ low-quality scan" : ""}
          </span>
        )}
      </div>
      {showLayers && (
        <div className="viewer-layers">
          {(
            [
              ["openings", "Openings (floor plans)"],
              ["references", "References (elevations, details)"],
              ["dimensions", "All dimensions"],
              ["detections", "All raw detections"],
            ] as const
          ).map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} /> {label}
            </label>
          ))}
          <div className="legend">
            <span><i style={{ background: BAND_COLORS.green }} /> High confidence / verified</span>
            <span><i style={{ background: BAND_COLORS.yellow }} /> Review recommended</span>
            <span><i style={{ background: BAND_COLORS.red }} /> Low confidence</span>
            <span><i style={{ background: "#1d4ed8" }} /> Associated dimension</span>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="viewer-search">
          <form onSubmit={runSearch}>
            <input autoFocus placeholder="Search tags, dimensions, notes…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="icon-btn" type="button" onClick={() => { setSearchOpen(false); setHits([]); setActiveHit(null); }}>
              <X size={14} />
            </button>
          </form>
          <div className="hits">
            {hits.length === 0 && q && <div className="muted small">Press Enter to search all pages</div>}
            {hits.map((h, i) => (
              <button
                key={i}
                className="hit"
                onClick={() => {
                  setActiveHit({ page_index: h.page_index, bbox: h.bbox });
                  if (page?.page_index !== h.page_index) props.onPageChange(h.page_index);
                  setTimeout(() => zoomTo(h.bbox), 60);
                }}
              >
                <b>{h.text}</b> <span className="muted">p.{h.page_index + 1} {h.sheet ?? ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={wrapRef}
        className={`viewer-canvas ${props.drawMode ? "draw" : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => zoomBy(1.6)}
      >
        {!page && <div className="viewer-empty">No drawing selected</div>}
        {page && !page.image_url && <div className="viewer-empty">This page has not been rendered yet</div>}
        {page && page.image_url && (
          <div className="viewer-stage" style={{ width: page.width, height: page.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
            <img className="viewer-img" src={page.image_url} alt={`Page ${page.page}`} draggable={false} />
            {hires && hires.page === page.id && (
              <img className="viewer-hires" src={hires.url} alt="" draggable={false} style={{ left: hires.x, top: hires.y, width: hires.w, height: hires.h }} />
            )}
            <svg className="viewer-svg" viewBox={`0 0 ${page.width} ${page.height}`} width={page.width} height={page.height}>
              {layers.detections &&
                overlay?.detections.map((d) => (
                  <rect key={d.id} x={d.bbox.x} y={d.bbox.y} width={d.bbox.width} height={d.bbox.height} className="ov-det" vectorEffect="non-scaling-stroke" />
                ))}
              {layers.dimensions &&
                overlay?.dimensions.map((d) => (
                  <g key={d.id} className="ov-dim">
                    {d.line && <line x1={d.line.x0} y1={d.line.y0} x2={d.line.x1} y2={d.line.y1} vectorEffect="non-scaling-stroke" />}
                    <rect x={d.text_bbox.x} y={d.text_bbox.y} width={d.text_bbox.width} height={d.text_bbox.height} vectorEffect="non-scaling-stroke" />
                  </g>
                ))}
              {boxes.map((b, i) => (
                <g
                  key={`${b.id}-${i}`}
                  className={`ov-open ${b.selected ? "sel" : ""}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSelect?.(b.id);
                  }}
                >
                  <rect
                    x={b.bbox.x - 2 * inv}
                    y={b.bbox.y - 2 * inv}
                    width={b.bbox.width + 4 * inv}
                    height={b.bbox.height + 4 * inv}
                    style={{ stroke: b.selected ? "#1d4ed8" : b.color, fill: b.selected ? "rgba(29,78,216,0.12)" : "rgba(0,0,0,0.001)" }}
                    strokeDasharray={b.dashed ? `${5 * inv} ${3 * inv}` : undefined}
                    strokeWidth={(b.selected ? 3 : 1.6) * inv}
                  />
                  {(b.selected || view.s > 0.9) && (
                    <text x={b.bbox.x} y={b.bbox.y - 5 * inv} fontSize={11 * inv} className="ov-label" style={{ fill: b.selected ? "#1d4ed8" : b.color }}>
                      {b.label}
                    </text>
                  )}
                </g>
              ))}
              {extras.map((h, i) => (
                <g key={`x${i}`} className="ov-extra">
                  {h.line && <line x1={h.line.x0} y1={h.line.y0} x2={h.line.x1} y2={h.line.y1} style={{ stroke: h.color }} strokeWidth={2.5 * inv} />}
                  {h.bbox && (
                    <rect x={h.bbox.x - 1.5 * inv} y={h.bbox.y - 1.5 * inv} width={h.bbox.width + 3 * inv} height={h.bbox.height + 3 * inv} style={{ stroke: h.color, fill: `${h.color}22` }} strokeWidth={2 * inv} />
                  )}
                </g>
              ))}
              {activeHit && activeHit.page_index === page.page_index && (
                <rect className="ov-hit" x={activeHit.bbox.x - 2 * inv} y={activeHit.bbox.y - 2 * inv} width={activeHit.bbox.width + 4 * inv} height={activeHit.bbox.height + 4 * inv} strokeWidth={2 * inv} />
              )}
              {drawBox && <rect className="ov-draw" x={drawBox.x} y={drawBox.y} width={drawBox.width} height={drawBox.height} strokeWidth={2 * inv} />}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
