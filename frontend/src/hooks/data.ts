import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AuditEvent, DocumentInfo, Job, Opening, Overlay, PageInfo, Project, ReviewItem, Run, Schedule, SystemInfo } from "../api/types";

export const qk = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  pages: (id: string) => ["pages", id] as const,
  overlay: (pid: string, pageId: string) => ["overlay", pid, pageId] as const,
  openings: (id: string) => ["openings", id] as const,
  documents: (id: string) => ["documents", id] as const,
  jobs: (id: string) => ["jobs", id] as const,
  review: (id: string) => ["review", id] as const,
  audit: (pid: string, oid: string) => ["audit", pid, oid] as const,
  schedule: (pid: string, g: string, u: string, inc: boolean) => ["schedule", pid, g, u, inc] as const,
  runs: (id: string) => ["runs", id] as const,
};

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: () => api<Project[]>("/api/projects"), refetchInterval: (q) => (q.state.data?.some((p) => p.stats?.job && ["queued", "running"].includes(p.stats.job.status)) ? 2000 : false) });
}

export function useProject(id: string | undefined) {
  return useQuery({ queryKey: qk.project(id ?? ""), queryFn: () => api<Project>(`/api/projects/${id}`), enabled: !!id });
}

export function usePages(id: string | undefined) {
  return useQuery({ queryKey: qk.pages(id ?? ""), queryFn: () => api<PageInfo[]>(`/api/projects/${id}/pages`), enabled: !!id, staleTime: 5 * 60 * 1000 });
}

export function useOverlay(pid: string | undefined, pageId: string | undefined) {
  return useQuery({
    queryKey: qk.overlay(pid ?? "", pageId ?? ""),
    queryFn: () => api<Overlay>(`/api/projects/${pid}/pages/${pageId}/overlay`),
    enabled: !!pid && !!pageId,
    staleTime: 10 * 60 * 1000,
  });
}

export function useOpenings(id: string | undefined) {
  return useQuery({ queryKey: qk.openings(id ?? ""), queryFn: () => api<Opening[]>(`/api/projects/${id}/openings`), enabled: !!id });
}

export function useDocuments(id: string | undefined) {
  return useQuery({ queryKey: qk.documents(id ?? ""), queryFn: () => api<DocumentInfo[]>(`/api/projects/${id}/documents`), enabled: !!id });
}

export function useJobs(id: string | undefined, poll: boolean) {
  return useQuery({ queryKey: qk.jobs(id ?? ""), queryFn: () => api<Job[]>(`/api/projects/${id}/jobs`), enabled: !!id, refetchInterval: poll ? 1000 : false });
}

export function useReview(id: string | undefined) {
  return useQuery({ queryKey: qk.review(id ?? ""), queryFn: () => api<{ count: number; items: ReviewItem[] }>(`/api/projects/${id}/review`), enabled: !!id });
}

export function useAudit(pid: string | undefined, oid: string | undefined) {
  return useQuery({ queryKey: qk.audit(pid ?? "", oid ?? ""), queryFn: () => api<AuditEvent[]>(`/api/projects/${pid}/openings/${oid}/audit`), enabled: !!pid && !!oid });
}

export function useSchedule(pid: string | undefined, groupBy: string, unit: string, includeUnverified = true) {
  return useQuery({
    queryKey: qk.schedule(pid ?? "", groupBy, unit, includeUnverified),
    queryFn: () => api<Schedule>(`/api/projects/${pid}/schedule?group_by=${groupBy}&unit=${unit}&include_unverified=${includeUnverified}`),
    enabled: !!pid,
  });
}

export function useRuns(pid: string | undefined) {
  return useQuery({ queryKey: qk.runs(pid ?? ""), queryFn: () => api<Run[]>(`/api/projects/${pid}/runs`), enabled: !!pid });
}

export function useSystem() {
  return useQuery({ queryKey: ["system"], queryFn: () => api<SystemInfo>("/api/system"), staleTime: 10 * 60 * 1000 });
}

/** Invalidate everything that depends on opening data after an edit. */
export function useInvalidateProject() {
  const qc = useQueryClient();
  return (pid: string) => {
    qc.invalidateQueries({ queryKey: qk.openings(pid) });
    qc.invalidateQueries({ queryKey: qk.review(pid) });
    qc.invalidateQueries({ queryKey: ["schedule", pid] });
    qc.invalidateQueries({ queryKey: ["audit", pid] });
    qc.invalidateQueries({ queryKey: qk.project(pid) });
    qc.invalidateQueries({ queryKey: qk.projects });
  };
}

export function useOpeningMutation(pid: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: async (a: { id: string; path?: string; method?: string; body?: unknown }) =>
      api<Opening>(`/api/projects/${pid}/openings/${a.id}${a.path ?? ""}`, { method: a.method ?? "PATCH", body: a.body }),
    onSuccess: (o) => {
      if (o && typeof o === "object" && "id" in o) {
        qc.setQueryData<Opening[]>(qk.openings(pid), (old) => (old ? old.map((x) => (x.id === o.id ? o : x)) : old));
      }
      invalidate(pid);
    },
  });
}
