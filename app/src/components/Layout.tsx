import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChevronsUpDown, ClipboardCheck, FolderOpen, LayoutDashboard, Plus, Ruler, ScanSearch, Settings, Upload } from "lucide-react";
import { useProjects } from "../hooks/data";
import { NewProjectModal } from "../pages/Dashboard";

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
      <nav className="dock" aria-label="Main">
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
          <NavLink to="/" end title="Dashboard">
            <LayoutDashboard size={16} /> <span className="lbl">Dashboard</span>
          </NavLink>
          <NavLink to="/projects" title="Projects">
            <FolderOpen size={16} /> <span className="lbl">Projects</span>
          </NavLink>
          <NavLink to={pnav("upload")} title="Upload Plans">
            <Upload size={16} /> <span className="lbl">Upload</span>
          </NavLink>
          <NavLink to={pnav("extraction")} title="Extraction">
            <ScanSearch size={16} /> <span className="lbl">Extraction</span>
          </NavLink>
          <NavLink to={pnav("review")} title="Review">
            <ClipboardCheck size={16} /> <span className="lbl">Review</span>
            {review > 0 && <span className="count">{review}</span>}
          </NavLink>
          <NavLink to={pnav("measurements")} title="Measurements">
            <Ruler size={16} /> <span className="lbl">Measurements</span>
          </NavLink>
          <NavLink to="/settings" state={{ from: loc.pathname }} title="Settings">
            <Settings size={16} /> <span className="lbl">Settings</span>
          </NavLink>
        </div>
        <div className="dock-right">
          <button className="dock-project" onClick={() => nav("/projects")} title={currentProject ? `Current project: ${currentProject.name}` : "Choose a project"}>
            <span>{currentProject ? currentProject.name : "No project selected"}</span>
            <ChevronsUpDown size={14} />
          </button>
          <button className="dock-add" onClick={() => setCreating(true)}>
            <span>New project</span>
            <i>
              <Plus size={17} />
            </i>
          </button>
        </div>
      </nav>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}
