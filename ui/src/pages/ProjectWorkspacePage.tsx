import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactDetail, Operation } from "../../../src/shared/api-contracts/agent-first";
import type { ContinuityRepairPlan } from "../../../src/shared/continuity-repair";
import type { CumulativeVerificationLedger, CumulativeVerificationTarget } from "../../../src/shared/cumulative-verification";
import type { ArtifactType } from "../types";
import { api } from "../api";
import { useProjectWorkspace } from "../hooks/useProjectWorkspace";
import { ArtifactEditor } from "../features/artifacts/ArtifactEditor";
import { AssetWorkspace } from "../features/assets/AssetWorkspace";
import { ArtifactNavigator, type WorkspaceSection } from "../features/artifacts/ArtifactNavigator";
import { ProjectAgentPanel } from "../features/agent/ProjectAgentPanel";
import { EditingWorkspace } from "../features/editing/EditingWorkspace";
import { GenerationWorkspace } from "../features/generation/GenerationWorkspace";
import { IssueDrawer } from "../features/issues/IssueDrawer";
import { IssueSummary } from "../features/issues/IssueSummary";
import { OperationHistory } from "../features/operations/OperationHistory";
import { QualityWorkspace } from "../features/quality/QualityWorkspace";
import { VerificationLedgerPanel } from "../features/verification/VerificationLedgerPanel";

function artifactTypeFromSection(section: WorkspaceSection): ArtifactType | null {
  return section.startsWith("artifact:") ? section.slice("artifact:".length) as ArtifactType : null;
}

function workspaceStorageKey(projectId: string, field: "section" | "artifact") {
  return `ai-video-studio:workspace:${projectId}:${field}`;
}

function storedSection(projectId: string): WorkspaceSection {
  const value = window.localStorage.getItem(workspaceStorageKey(projectId, "section"));
  if (value === "generation" || value === "quality" || value === "editing" || value?.startsWith("artifact:")) return value as WorkspaceSection;
  return "artifact:screenplay";
}

export function ProjectWorkspacePage({ projectId, onBack, onLegacy }: { projectId: string; onBack: () => void; onLegacy: () => void }) {
  const { workspace, loading, error, reload } = useProjectWorkspace(projectId);
  const [section, setSection] = useState<WorkspaceSection>(() => storedSection(projectId));
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(() => window.localStorage.getItem(workspaceStorageKey(projectId, "artifact")));
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [historyOperationId, setHistoryOperationId] = useState<string | null>(null);
  const [repairPlan, setRepairPlan] = useState<ContinuityRepairPlan | null>(null);
  const [verificationLedger, setVerificationLedger] = useState<CumulativeVerificationLedger | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const detailRequestId = useRef(0);
  const type = artifactTypeFromSection(section);
  const group = useMemo(() => workspace?.artifactGroups.find((item) => item.type === type) ?? null, [workspace, type]);

  useEffect(() => { window.localStorage.setItem(workspaceStorageKey(projectId, "section"), section); }, [projectId, section]);
  useEffect(() => {
    const key = workspaceStorageKey(projectId, "artifact");
    if (selectedArtifactId) window.localStorage.setItem(key, selectedArtifactId);
    else window.localStorage.removeItem(key);
  }, [projectId, selectedArtifactId]);

  useEffect(() => {
    if (!group) { setSelectedArtifactId(null); setDetail(null); return; }
    if (!selectedArtifactId || !group.versions.some((version) => version.id === selectedArtifactId)) setSelectedArtifactId(group.head?.id ?? group.versions[0]?.id ?? null);
  }, [group?.type, group?.head?.id, group?.versions.length, selectedArtifactId]);

  const loadDetail = useCallback(async () => {
    const requestId = ++detailRequestId.current;
    if (!selectedArtifactId) { setDetail(null); setDetailLoading(false); setDetailError(null); return; }
    setDetailLoading(true); setDetailError(null);
    try {
      const response = await api.getArtifactDetail(projectId, selectedArtifactId);
      if (detailRequestId.current === requestId) setDetail(response);
    } catch (reason) {
      if (detailRequestId.current === requestId) setDetailError(reason instanceof Error ? reason.message : "版本载入失败");
    } finally {
      if (detailRequestId.current === requestId) setDetailLoading(false);
    }
  }, [projectId, selectedArtifactId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => {
    setRepairPlan(null);
    if (detail?.artifact.type !== "storyboard") return;
    void api.getContinuityRepairPlan(projectId, detail.artifact.id)
      .then((response) => setRepairPlan(response.plan))
      .catch(() => setRepairPlan(null));
  }, [projectId, detail?.artifact.id, detail?.artifact.type]);
  useEffect(() => {
    const through: CumulativeVerificationTarget | null = type ?? (["generation", "quality", "editing"].includes(section) ? "production" : null);
    if (!through || (type && !detail)) { setVerificationLedger(null); setVerificationError(null); return; }
    let active = true;
    setVerificationLoading(true);
    setVerificationError(null);
    void api.getVerificationLedger(projectId, through, type ? detail?.artifact.id : null)
      .then((response) => { if (active) setVerificationLedger(response.ledger); })
      .catch((reason) => { if (active) { setVerificationLedger(null); setVerificationError(reason instanceof Error ? reason.message : "累计核查失败"); } })
      .finally(() => { if (active) setVerificationLoading(false); });
    return () => { active = false; };
  }, [projectId, section, type, detail?.artifact.id, detail?.artifact.updatedAt, workspace?.project.updatedAt]);
  const refreshAll = useCallback(async () => { await reload(); await loadDetail(); }, [reload, loadDetail]);
  const startStructuredRepair = useCallback(async () => {
    if (!detail) throw new Error("请先打开要处理的版本");
    const result = await api.createContinuityRepairOperation(projectId, detail.artifact.id, crypto.randomUUID());
    setHistoryOperationId(result.operationId);
    setIssuesOpen(false);
    await reload();
  }, [detail?.artifact.id, projectId, reload]);
  const handleOperationTerminal = useCallback((operation: Operation) => {
    if (operation.kind !== "artifact.continuity-repair" || operation.status !== "succeeded") return;
    const artifactId = typeof operation.resultPayload?.artifactId === "string" ? operation.resultPayload.artifactId : null;
    const artifactType = typeof operation.resultPayload?.artifactType === "string" ? operation.resultPayload.artifactType as ArtifactType : null;
    if (!artifactId || !artifactType) return;
    setSection(`artifact:${artifactType}`);
    setSelectedArtifactId(artifactId);
  }, []);

  if (loading && !workspace) return <main className="af-shell af-center"><div className="af-spinner" /><p>正在建立项目工作区…</p></main>;
  if (error && !workspace) return <main className="af-shell af-center"><h2>工作区无法打开</h2><p>{error}</p><button onClick={onBack}>返回项目列表</button></main>;
  if (!workspace) return null;

  return <main className="af-shell">
    <header className="af-topbar">
      <div><button className="af-back" onClick={onBack}>← 所有项目</button><span className="af-brand">小破软件</span></div>
      <div className="af-project-heading"><strong>{workspace.project.title}</strong><span>{workspace.project.targetDurationSec}s · {workspace.project.aspectRatio} · {workspace.project.resolution}</span></div>
      <div><button onClick={() => void refreshAll()}>刷新</button><button onClick={onLegacy}>兼容入口</button></div>
    </header>
    {error && <div className="af-global-error">刷新失败：{error}</div>}
    <div className="af-workspace-grid">
      <aside className="af-left-column">
        <ArtifactNavigator workspace={workspace} selected={section} onSelect={(next) => { if (next === section) return; setSection(next); setDetail(null); setSelectedArtifactId(null); }} />
        <IssueSummary issues={workspace.issues.filter((issue) => !detail || issue.scopeId === detail.artifact.id || issue.scopeType === "project")} onOpen={() => setIssuesOpen(true)} />
        <details className="af-history-panel"><summary>作业历史</summary><OperationHistory operations={workspace.operations} onOpen={setHistoryOperationId} /></details>
      </aside>
      <div className="af-middle-column">
        {detailError && <div className="af-global-error">{detailError}</div>}
        <VerificationLedgerPanel ledger={verificationLedger} loading={verificationLoading} error={verificationError} />
        {type === "asset-bible" && group ? <AssetWorkspace
          projectId={projectId} label={group.label} versions={group.versions} selectedId={selectedArtifactId}
          detail={detail} loading={detailLoading} onSelectVersion={setSelectedArtifactId} onChanged={refreshAll} onOpenIssues={() => setIssuesOpen(true)}
          onStartStructuredRepair={startStructuredRepair}
          verificationLedger={verificationLedger}
        /> : type && group ? <ArtifactEditor
          projectId={projectId} label={group.label} versions={group.versions} selectedId={selectedArtifactId}
          detail={detail} loading={detailLoading} onSelectVersion={setSelectedArtifactId} onChanged={refreshAll} onOpenIssues={() => setIssuesOpen(true)}
          onStartStructuredRepair={startStructuredRepair} repairPlan={repairPlan}
          verificationLedger={verificationLedger}
        /> : section === "generation" ? <GenerationWorkspace projectId={projectId} workspace={workspace} onChanged={refreshAll} onOperation={setHistoryOperationId} />
          : section === "quality" ? <QualityWorkspace projectId={projectId} workspace={workspace} onChanged={refreshAll} />
            : <EditingWorkspace projectId={projectId} workspace={workspace} onChanged={refreshAll} onOperation={setHistoryOperationId} />}
      </div>
      <ProjectAgentPanel projectId={projectId} detail={detail} onWorkspaceChanged={refreshAll} initialOperationId={historyOperationId} onOperationTerminal={handleOperationTerminal} />
    </div>
    <IssueDrawer projectId={projectId} issues={workspace.issues} scopeId={detail?.artifact.id ?? null} open={issuesOpen} onClose={() => setIssuesOpen(false)} onChanged={refreshAll} repairPlan={repairPlan} verificationLedger={verificationLedger} onStartStructuredRepair={detail?.artifact.type === "storyboard" ? startStructuredRepair : undefined} />
  </main>;
}
