import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronsUpDown, ClipboardCheck, FolderOpen, LayoutDashboard, Plus, Ruler, ScanSearch, Settings, Upload } from "lucide-react";
import { useProjects } from "../hooks/data";
import { NewProjectModal } from "../pages/Dashboard";
import { DesktopFileBridge } from "./ProjectFile";
import { t } from "../i18n";

const LAST_PROJECT = "pm:lastProject";

export function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* storage unavailable */
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export default function Layout() {
  const { pid } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const current = pid ?? lastProject() ?? undefined;
  const currentProject = projects.data?.find((p) => p.id === current);
  const projectId = currentProject?.id;

  useEffect(() => {
    if (pid) rememberProject(pid);
  }, [pid]);

  const pnav = (path: string) => (projectId ? `/p/${projectId}/${path}` : "/projects?pick=" + path);
  const review = currentProject?.stats?.needs_review ?? 0;

  return (
    <div className="app">
      <main className="main">
        <Outlet />
      </main>
      <nav className="dock" aria-label={t("Main navigation")}>
        <div className="brand" onClick={() => nav("/")} onKeyDown={(e) => e.key === "Enter" && nav("/")} role="link" tabIndex={0}>
          <span className="logo">
            <Ruler size={15} />
          </span>
          <span>
            PlanMeasure <b>AI</b>
          </span>
        </div>
        <span className="dock-sep" />
        <div className="dock-nav">
          <NavLink to="/" end title={t("Dashboard")}>
            <LayoutDashboard size={16} /> <span className="lbl">{t("Dashboard")}</span>
          </NavLink>
          <NavLink to="/projects" title={t("Projects")}>
            <FolderOpen size={16} /> <span className="lbl">{t("Projects")}</span>
          </NavLink>
          <NavLink to={pnav("upload")} title={t("Upload Plans")}>
            <Upload size={16} /> <span className="lbl">{t("Upload")}</span>
          </NavLink>
          <NavLink to={pnav("extraction")} title={t("Extraction")}>
            <ScanSearch size={16} /> <span className="lbl">{t("Extraction")}</span>
          </NavLink>
          <NavLink to={pnav("review")} title={t("Review")}>
            <ClipboardCheck size={16} /> <span className="lbl">{t("Review")}</span>
            {review > 0 && <span className="count">{review}</span>}
          </NavLink>
          <NavLink to={pnav("measurements")} title={t("Measurements")}>
            <Ruler size={16} /> <span className="lbl">{t("Measurements")}</span>
          </NavLink>
          <NavLink to="/settings" state={{ from: loc.pathname }} title={t("Settings")}>
            <Settings size={16} /> <span className="lbl">{t("Settings")}</span>
          </NavLink>
        </div>
        <div className="dock-right">
          <button className="dock-project" onClick={() => nav("/projects")} title={currentProject ? t("Current project: {name}", { name: currentProject.name }) : t("Choose a project")}>
            <span>{currentProject ? currentProject.name : t("No project selected")}</span>
            <ChevronsUpDown size={14} />
          </button>
          <button className="dock-add" onClick={() => setCreating(true)}>
            <span>{t("New project")}</span>
            <i>
              <Plus size={17} />
            </i>
          </button>
        </div>
      </nav>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      <DesktopFileBridge />
    </div>
  );
}
