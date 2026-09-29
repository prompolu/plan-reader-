import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import Layout from "./components/Layout";
import { useAuth } from "./hooks/auth";
import Dashboard from "./pages/Dashboard";
import Extraction from "./pages/Extraction";
import Measurements from "./pages/Measurements";
import PrintView from "./pages/PrintView";
import Projects from "./pages/Projects";
import Review from "./pages/Review";
import Settings from "./pages/Settings";
import Upload from "./pages/Upload";
import { t } from "./i18n";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  if (loading) return <div className="boot">{t("Loading…")}</div>;
  if (!user)
    return (
      <div className="boot">
        <p>{t("Could not open your projects")}{error ? `: ${error}` : ""}.</p>
        <button className="btn" onClick={refresh}>
          {t("Try again")}
        </button>
      </div>
    );
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/p/:pid/print"
        element={
          <RequireAuth>
            <PrintView />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/p/:pid/upload" element={<Upload />} />
        <Route path="/p/:pid/extraction" element={<Extraction />} />
        <Route path="/p/:pid/review" element={<Review />} />
        <Route path="/p/:pid/measurements" element={<Measurements />} />
        <Route path="/p/:pid" element={<Navigate to="extraction" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
