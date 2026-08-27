import { useEffect, useState } from "react";
import type { Project } from "./types";
import { api } from "./api";
import { App as LegacyApp } from "./App";
import { ProjectWorkspacePage } from "./pages/ProjectWorkspacePage";
import "./styles/agent-first.css";

export function RootApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => window.localStorage.getItem("ai-video-studio:selected-project"));
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects() {
    setLoading(true); setError(null);
    try {
      const response = await api.listProjects();
      setProjects(response.projects);
      if (selectedId && !response.projects.some((project) => project.id === selectedId)) setSelectedId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目列表载入失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => {
    if (selectedId) window.localStorage.setItem("ai-video-studio:selected-project", selectedId);
    else window.localStorage.removeItem("ai-video-studio:selected-project");
  }, [selectedId]);

  if (legacy) return <div className="af-legacy-wrap"><div className="af-legacy-banner"><span>兼容入口只用于旧操作；默认工作区不依赖九阶段门禁。</span><button onClick={() => { setLegacy(false); void loadProjects(); }}>返回 Agent-first 工作区</button></div><LegacyApp /></div>;
  if (selectedId) return <ProjectWorkspacePage projectId={selectedId} onBack={() => setSelectedId(null)} onLegacy={() => setLegacy(true)} />;
  return <main className="af-projects-page">
    <header><div><span className="af-brand">小破软件</span><h1>AI Video Studio</h1><p>资料、版本、任务和问题都回到一个长期存在的项目工作区。</p></div><button onClick={() => setLegacy(true)}>新建项目 / 兼容入口</button></header>
    {error && <div className="af-global-error">{error}</div>}
    {loading ? <div className="af-center"><div className="af-spinner" /><p>正在读取原有项目…</p></div> : <section className="af-project-grid">
      {projects.map((project) => <button key={project.id} onClick={() => setSelectedId(project.id)}>
        <span className="af-kicker">PROJECT WORKSPACE</span><h2>{project.title}</h2>
        <p>{project.targetDurationSec}s · {project.aspectRatio} · {project.resolution}</p>
        <div><span>资料工作区</span><time>{new Date(project.updatedAt).toLocaleString("zh-CN")}</time></div>
      </button>)}
      {!projects.length && <div className="af-empty"><strong>还没有项目</strong><p>从兼容入口创建首个项目，之后会原地出现在这里。</p></div>}
    </section>}
  </main>;
}
