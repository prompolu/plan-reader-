import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, ImageIcon, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { api, uploadWithProgress } from "../api/client";
import type { DocumentInfo, Job } from "../api/types";
import { qk, useDocuments, useJobs, useProject, useSystem } from "../hooks/data";
import { fmtBytes, fmtDate, ProgressBar, StepList, useToast } from "../components/ui";
import { t, tp, tx } from "../i18n";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

interface Pending {
  file: File;
  error?: string;
}

export default function Upload() {
  const { pid } = useParams();
  const project = useProject(pid);
  const docs = useDocuments(pid);
  const system = useSystem();
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [rejected, setRejected] = useState<{ filename: string; error: string }[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const jobs = useJobs(pid, true);
  const job: Job | undefined = jobs.data?.[0];
  const active = job && ["queued", "running"].includes(job.status);
  const maxMb = system.data?.limits.max_upload_mb ?? 200;
  const canEdit = project.data?.role !== "viewer";

  useEffect(() => {
    if (job?.status === "succeeded") {
      qc.invalidateQueries({ queryKey: qk.documents(pid!) });
      qc.invalidateQueries({ queryKey: qk.pages(pid!) });
      qc.invalidateQueries({ queryKey: qk.openings(pid!) });
      qc.invalidateQueries({ queryKey: qk.project(pid!) });
      qc.invalidateQueries({ queryKey: qk.projects });
    }
  }, [job?.status, job?.id, pid, qc]);

  const add = (files: FileList | File[]) => {
    const next: Pending[] = [];
    for (const f of Array.from(files)) {
      const ext = f.name.toLowerCase().split(".").pop() ?? "";
      let error: string | undefined;
      if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) error = t("Unsupported type – PDF, PNG or JPG only");
      else if (f.size > maxMb * 1024 * 1024) error = t("Larger than {n} MB", { n: maxMb });
      next.push({ file: f, error });
    }
    setPending((p) => [...p, ...next]);
  };

  const start = async () => {
    const ok = pending.filter((p) => !p.error);
    if (!ok.length) return;
    const form = new FormData();
    ok.forEach((p) => form.append("files", p.file, p.file.name));
    setUploading(0);
    setRejected([]);
    try {
      const r = await uploadWithProgress<{ documents: DocumentInfo[]; errors: { filename: string; error: string }[]; job: Job | null }>(`/api/projects/${pid}/documents`, form, setUploading);
      setRejected(r.errors);
      setPending([]);
      toast(t("{n} file(s) added – processing started", { n: r.documents.length }));
      qc.invalidateQueries({ queryKey: qk.documents(pid!) });
      qc.invalidateQueries({ queryKey: qk.jobs(pid!) });
    } catch (e) {
      const details = (e as { details?: { detail?: { errors?: { filename: string; error: string }[] } } }).details;
      setRejected(details?.detail?.errors ?? []);
      toast((e as Error).message, "error");
    } finally {
      setUploading(null);
    }
  };

  const reprocess = async () => {
    try {
      await api(`/api/projects/${pid}/process`, { method: "POST" });
      qc.invalidateQueries({ queryKey: qk.jobs(pid!) });
      toast(t("Re-extraction queued – your edits and verifications are preserved"));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const removeDoc = async (d: DocumentInfo) => {
    if (!confirm(t("Remove {name}? Its pages will be removed; openings you edited are kept.", { name: d.filename }))) return;
    await api(`/api/projects/${pid}/documents/${d.id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: qk.documents(pid!) });
    qc.invalidateQueries({ queryKey: qk.pages(pid!) });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Upload Plans")}</h1>
          <p className="muted">{project.data?.name} — {t("PDF drawing sets (single or multi-page) or scanned images (PNG, JPG). Files stay on this device – nothing is uploaded to a server.")}</p>
        </div>
        {docs.data && docs.data.length > 0 && canEdit && (
          <button className="btn" onClick={reprocess} disabled={!!active}>
            <RefreshCw size={15} /> {t("Re-extract all")}
          </button>
        )}
      </div>

      <div className="upload-layout">
        <div>
          {canEdit && (
            <div
              className={`dropzone ${drag ? "drag" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                add(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <UploadCloud size={36} />
              <div>
                <b>{t("Drop drawings here")}</b> {t("or click to choose files")}
              </div>
              <div className="small muted">{t("PDF, PNG, JPG · up to {n} MB each · multiple files allowed", { n: maxMb })}</div>
              <input ref={inputRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && add(e.target.files)} data-testid="file-input" />
            </div>
          )}
          {pending.length > 0 && (
            <div className="card">
              <h3>{t("Ready to upload")}</h3>
              <ul className="file-list">
                {pending.map((p, i) => (
                  <li key={i} className={p.error ? "bad" : ""}>
                    {p.file.type === "application/pdf" || p.file.name.toLowerCase().endsWith(".pdf") ? <FileText size={16} /> : <ImageIcon size={16} />}
                    <span className="grow">{p.file.name}</span>
                    <span className="muted small">{fmtBytes(p.file.size)}</span>
                    {p.error && <span className="error-text small">{p.error}</span>}
                    <button className="icon-btn" onClick={() => setPending((x) => x.filter((_, j) => j !== i))} aria-label={t("Remove")}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              {uploading !== null ? (
                <div>
                  <div className="small">{t("Reading files…")} {Math.round(uploading * 100)}%</div>
                  <ProgressBar value={uploading} />
                </div>
              ) : (
                <button className="btn btn-primary" onClick={start} disabled={!pending.some((p) => !p.error)}>
                  <UploadCloud size={15} /> {t("Upload and analyse")}
                </button>
              )}
            </div>
          )}
          {rejected.length > 0 && (
            <div className="banner banner-error">
              <b>{t("Some files were not accepted:")}</b>
              <ul>
                {rejected.map((r, i) => (
                  <li key={i}>
                    {r.filename}: {tx(r.error)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <h3>{t("Drawings in this project")}</h3>
            {docs.data && docs.data.length === 0 && <div className="muted">{t("No drawings uploaded yet.")}</div>}
            <ul className="file-list">
              {(docs.data ?? []).map((d) => (
                <li key={d.id}>
                  {d.content_type === "application/pdf" ? <FileText size={16} /> : <ImageIcon size={16} />}
                  <span className="grow">
                    <b>{d.filename}</b>
                    <div className="small muted">
                      {fmtBytes(d.size_bytes)} · {tp(d.page_count, "{n} page", "{n} pages")} · {t("uploaded {date}", { date: fmtDate(d.created_at) })}
                    </div>
                  </span>
                  <span className={`badge ${d.status === "processed" ? "badge-green" : d.status === "failed" ? "badge-red" : "badge-gray"}`}>{t(d.status)}</span>
                  {canEdit && (
                    <button className="icon-btn" onClick={() => removeDoc(d)} aria-label={t("Remove {name}", { name: d.filename })}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="card processing">
          <h3>{t("Processing")}</h3>
          {!job && <div className="muted">{t("Upload drawings to start the analysis.")}</div>}
          {job && (
            <>
              <div className="row between">
                <span className={`badge ${job.status === "succeeded" ? "badge-green" : job.status === "failed" ? "badge-red" : "badge-blue"}`}>{t(job.status)}</span>
                <span className="small muted">{Math.round(job.progress * 100)}%</span>
              </div>
              <ProgressBar value={job.progress} />
              <StepList job={job} />
              {job.status === "failed" && (
                <div className="banner banner-error">
                  <AlertTriangle size={14} /> {job.error}
                </div>
              )}
              {job.status === "succeeded" && (
                <div className="banner banner-ok">
                  <CheckCircle2 size={14} /> {t("Extraction complete.")}{" "}
                  <Link to={`/p/${pid}/extraction`}>{t("Open the extraction workspace →")}</Link>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
