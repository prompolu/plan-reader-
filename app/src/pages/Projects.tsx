import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { qk, useProjects } from "../hooks/data";
import { fmtDate, useToast } from "../components/ui";
import { NewProjectModal, useCreateDemo } from "./Dashboard";
import { OpenProjectFileButton, SaveProjectFileButton } from "../components/ProjectFile";

export default function Projects() {
  const projects = useProjects();
  const [params] = useSearchParams();
  const pick = params.get("pick");
  const [creating, setCreating] = useState(false);
  const demo = useCreateDemo();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}" and all its drawings and measurements? This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(id) });
      qc.invalidateQueries({ queryKey: qk.projects });
      toast("Project deleted");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          {pick && <p className="banner banner-info">Choose a project to continue to {pick === "upload" ? "Upload Plans" : pick.charAt(0).toUpperCase() + pick.slice(1)}.</p>}
        </div>
        <div className="row gap wrap">
          <OpenProjectFileButton />
          <button className="btn" onClick={demo.run} disabled={demo.busy}>
            <FlaskConical size={15} /> Demo project
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New project
          </button>
        </div>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="r">Pages</th>
              <th className="r">Openings</th>
              <th className="r">Need review</th>
              <th>Last processed</th>
              <th>Last changed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(projects.data ?? []).map((p) => (
              <tr key={p.id} className="clickable" onClick={() => nav(`/p/${p.id}/${pick ?? "extraction"}`)}>
                <td>
                  <Link to={`/p/${p.id}/${pick ?? "extraction"}`} onClick={(e) => e.stopPropagation()}>
                    <b>{p.name}</b>
                  </Link>
                  {p.is_demo && <span className="badge badge-blue">Demo</span>}
                  <div className="small muted">{p.info?.drawing_set_name}</div>
                </td>
                <td className="r">{p.stats?.pages ?? 0}</td>
                <td className="r">{p.stats?.openings ?? 0}</td>
                <td className="r">{p.stats?.needs_review ? <span className="badge badge-amber">{p.stats.needs_review}</span> : 0}</td>
                <td>{fmtDate(p.last_processed_at)}</td>
                <td className="muted">{fmtDate(p.updated_at)}</td>
                <td className="r nowrap">
                  <SaveProjectFileButton projectId={p.id} compact />
                  {p.role === "owner" && (
                    <button
                      className="icon-btn"
                      title="Delete project"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(p.id, p.name);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {projects.data && projects.data.length === 0 && (
              <tr>
                <td colSpan={7} className="muted center">
                  No projects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}
