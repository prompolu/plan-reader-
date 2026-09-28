import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { BBox, DisplayUnit } from "../api/types";
import type { ExtraHighlight, Focus } from "../components/DrawingViewer";
import type { NavTarget } from "../components/OpeningDetails";
import { DEFAULT_THRESHOLDS } from "../lib/confidence";
import { useOpenings, useOverlay, usePages, useProject } from "./data";

/** Shared state for pages that combine the drawing viewer with opening details. */
export function useWorkspace(pid: string | undefined) {
  const project = useProject(pid);
  const pages = usePages(pid);
  const openings = useOpenings(pid);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("opening");
  const [pageIndex, setPageIndex] = useState<number | null>(params.get("page") ? Number(params.get("page")) : null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [extra, setExtra] = useState<ExtraHighlight[]>([]);
  const [unitOverride, setUnitOverride] = useState<DisplayUnit | null>(null);

  const thresholds = project.data?.settings.thresholds ?? DEFAULT_THRESHOLDS;
  const unit: DisplayUnit = unitOverride ?? project.data?.settings.display_unit ?? "mm";
  const selected = useMemo(() => openings.data?.find((o) => o.id === selectedId) ?? null, [openings.data, selectedId]);

  // default page: first floor plan (or first page)
  useEffect(() => {
    if (pageIndex === null && pages.data?.length) {
      const fp = pages.data.find((p) => p.page_type === "floor_plan") ?? pages.data[0];
      setPageIndex(fp.page_index);
    }
  }, [pages.data, pageIndex]);

  const page = pages.data?.find((p) => p.page_index === pageIndex);
  const overlay = useOverlay(pid, page?.id);

  const goTo = useCallback((t: NavTarget) => {
    setPageIndex(t.page_index);
    if (t.bbox) setFocus({ bbox: t.bbox, key: `${t.page_index}:${t.bbox.x}:${t.bbox.y}:${Date.now()}` });
    setExtra(t.color && t.bbox ? [{ bbox: t.bbox, color: t.color }] : []);
  }, []);

  const select = useCallback(
    (id: string | null, navigate = true) => {
      const next = new URLSearchParams(params);
      if (id) next.set("opening", id);
      else next.delete("opening");
      setParams(next, { replace: true });
      if (!id || !navigate) return;
      const o = openings.data?.find((x) => x.id === id);
      if (!o) return;
      // prefer staying on the current page if the opening appears on it
      const here = [...o.instances, ...o.references].find((i) => i.page_index === pageIndex);
      const target = here ?? o.instances[0] ?? o.references[0];
      if (target) goTo({ page_index: target.page_index, bbox: target.bbox });
      else if (o.page_index !== null) goTo({ page_index: o.page_index, bbox: o.bbox as BBox | null });
      setExtra([]);
    },
    [params, setParams, openings.data, pageIndex, goTo],
  );

  return {
    project,
    pages,
    openings,
    thresholds,
    unit,
    setUnit: setUnitOverride,
    selected,
    selectedId,
    select,
    page,
    pageIndex,
    setPageIndex: (i: number) => {
      setPageIndex(i);
      setExtra([]);
    },
    overlay,
    focus,
    extra,
    goTo,
    canEdit: project.data?.role === "owner" || project.data?.role === "editor",
  };
}
