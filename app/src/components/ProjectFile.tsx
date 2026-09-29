import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Save } from "lucide-react";
import { ApiError, downloadBlob, isIOS, openProjectFile } from "../api/client";
import type { Project } from "../api/types";
import { fmtDate, Modal, useToast } from "./ui";
import { t } from "../i18n";

/** Save a project as a .planmeasure file (drawings, results, edits and audit trail). */
export function useSaveProjectFile() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (projectId: string) => {
    setBusy(true);
    try {
      await downloadBlob(`/api/projects/${projectId}/file`, undefined, "project.planmeasure", "GET");
      toast(t("Project file saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return { save, busy };
}

export function SaveProjectFileButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const { save, busy } = useSaveProjectFile();
  if (compact)
    return (
      <button
        className="icon-btn"
        title={t("Save project file")}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          save(projectId);
        }}
      >
        <Save size={15} />
      </button>
    );
  return (
    <button className="btn" onClick={() => save(projectId)} disabled={busy} title={t("Save everything in this project to a file you can keep, share or open on another device")}>
      <Save size={15} /> {busy ? t("Saving…") : t("Save project file")}
    </button>
  );
}

type Existing = { id: string; name: string; updated_at: string };

/** Open .planmeasure files; asks what to do when the project is already here. */
export function useOpenProjectFile() {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ file: File; existing: Existing } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();

  const open = async (file: File, mode: "new" | "replace" | "copy" = "new") => {
    setBusy(true);
    try {
      const p = await openProjectFile<Project>(file, mode);
      setConflict(null);
      // cached views of a replaced or re-opened project are out of date
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(p.id) });
      await qc.invalidateQueries();
      toast(mode === "replace" ? t("Project replaced with the version in the file") : t("Opened “{name}”", { name: p.name }));
      nav(`/p/${p.id}/extraction`);
    } catch (e) {
      const existing = e instanceof ApiError && e.status === 409 ? (e.details as { existing?: Existing } | undefined)?.existing : undefined;
      if (existing) setConflict({ file, existing });
      else toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const modal = conflict && (
    <Modal title={t("This project is already here")} onClose={() => setConflict(null)}>
      <p>
        {t("“{name}” is already in the app (last changed {date}).", { name: conflict.existing.name, date: fmtDate(conflict.existing.updated_at) })}
      </p>
      <p className="small muted">{t("Replace it with the version in the file, or open the file as a separate copy and keep both.")}</p>
      <div className="row gap wrap" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" onClick={() => setConflict(null)} disabled={busy}>
          {t("Cancel")}
        </button>
        <button className="btn" onClick={() => open(conflict.file, "copy")} disabled={busy}>
          {t("Open as a copy")}
        </button>
        <button className="btn btn-primary" onClick={() => open(conflict.file, "replace")} disabled={busy}>
          {t("Replace")}
        </button>
      </div>
    </Modal>
  );
  return { open, busy, modal };
}

export function OpenProjectFileButton({ className = "btn" }: { className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { open, busy, modal } = useOpenProjectFile();
  return (
    <>
      <button className={className} onClick={() => input.current?.click()} disabled={busy}>
        <FolderOpen size={15} /> {busy ? t("Opening…") : t("Open project file")}
      </button>
      <input
        ref={input}
        type="file"
        // iOS greys out file types it does not know, so it gets no filter (the file is checked on opening)
        accept={isIOS() ? undefined : ".planmeasure,application/zip"}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) open(f);
        }}
      />
      {modal}
    </>
  );
}

interface DesktopBridge {
  platform: string;
  onOpenFile(cb: (f: { name: string; data: Uint8Array }) => void): void;
  chooseProjectFile(): void;
  setLanguage?(lang: string): void;
}

/** The desktop app, when running inside it. */
export function desktop(): DesktopBridge | null {
  return (window as unknown as { planmeasureDesktop?: DesktopBridge }).planmeasureDesktop ?? null;
}

/** Desktop app: open project files double-clicked in Finder / Explorer or chosen from the File menu. */
export function DesktopFileBridge() {
  const { open, modal } = useOpenProjectFile();
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    desktop()?.onOpenFile(({ name, data }) => latest.current(new File([data as BlobPart], name)));
  }, []);
  return <>{modal}</>;
}

