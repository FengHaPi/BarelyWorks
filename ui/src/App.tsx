import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { h3ProductDurationMin, isH3ProductDurationCompatible } from "../../src/shared/h3-duration-policy";
import { H3_PROMPT_PLATFORM_MAX_CHARACTERS, h3PromptTargetCharacters } from "../../src/shared/h3-prompt-budget";
import { inspectShootingScriptPreflight } from "../../src/shared/shooting-script-preflight";
import { api, type AutoContinuityRepairSummary } from "./api";
import { formatRefreshWarning, runMutationWithRefresh } from "./async-state";
import { generationPreparationPlan, legacyPhysicalShotIds, nextArtifactByApprovedStage, packageCandidates, shotPreflightLabel } from "./auto-flow";
import { continuityIssueGroupTitle, groupContinuityIssues } from "./continuity-presentation";
import { createProjectDraftStorageKey, hasMeaningfulCreateProjectDraft, parseCreateProjectDraft, serializeCreateProjectDraft } from "./create-project-draft";
import { currentProjectStepIndex, projectStepState, projectStepStateLabels, projectWorkbenchSteps, type ProjectWorkbenchView } from "./project-workbench";
import { isDraftBaselineStale, reconcileProjectSelection, recoverDraftExpectedLatestArtifactId, shouldSkipForegroundRefreshForFilePicker } from "./project-refresh";
import { createEmptyQualityReview, createQuickAcceptedReview, createQuickRejectedReview, quickReviewIssues, type QuickReviewIssueId } from "./quality-review";
import { reviewDimensions, type Artifact, type ArtifactType, type Asset, type AssetDesignMode, type AssetReferencePromptRecord, type AssetReferenceRole, type ContinuityReport, type CreateProjectInput, type GenerationCenter, type GenerationReadiness, type GenerationResolution, type Health, type ImageProviderCapabilities, type ImportedGeneration, type MediaToolStatus, type Project, type ProjectIntegrityAudit, type ProjectIntegrityStepId, type ProjectOperationStatus, type ProjectStage, type QualityCenter, type QualityDecision, type QualityReviewInput, type ReviewDimensionStatus, type ShotSpec, type SkillProvenance, type SourceType, type StoryboardContinuityReviewSummary } from "./types";
import { validateReferenceUpload } from "./upload";
import { hasReachedProjectStage } from "./workflow-stage";

const stageGroups = projectWorkbenchSteps;
const allStages = projectWorkbenchSteps.flatMap((group) => group.stages);

const stageLabels: Record<ProjectStage, string> = {
  SOURCE_IMPORTED: "原始内容已入库",
  OUTLINE_REVIEW: "剧情大纲待审核",
  OUTLINE_APPROVED: "剧情大纲已批准",
  SCREENPLAY_REVIEW: "影视剧本待审核",
  SCREENPLAY_APPROVED: "影视剧本已批准",
  ASSET_BIBLE_REVIEW: "资产定义待审核",
  ASSET_BIBLE_APPROVED: "资产定义已批准",
  SHOOTING_SCRIPT_REVIEW: "导演脚本待审核",
  SHOOTING_SCRIPT_APPROVED: "导演脚本已批准",
  STORYBOARD_REVIEW: "分镜待审核",
  STORYBOARD_APPROVED: "分镜已批准",
  ASSETS_LOCKED: "资产已锁定",
  READY_FOR_GENERATION: "等待生成",
  GENERATING: "生成进行中",
  GENERATION_REVIEW: "生成结果待质检",
  EDITING: "粗剪进行中",
  FINAL_REVIEW: "成片待终审",
  DELIVERED: "项目已交付",
};

const sourceLabels: Record<SourceType, string> = {
  story: "原始故事 / 创意",
  screenplay: "已完成影视剧本",
  "shooting-script": "已完成导演脚本",
  storyboard: "已有分镜和素材",
};

const emptyForm: CreateProjectInput = {
  title: "",
  sourceType: "story",
  sourceText: "",
  targetDurationSec: 60,
  aspectRatio: "16:9",
  resolution: "1920x1080",
  videoType: "叙事短片",
  visualStyle: "",
  releasePlatform: "",
  targetAudience: "",
  allowStorySuggestions: true,
};

const outputResolutionOptions: Record<string, string[]> = {
  "16:9": ["1920x1080", "1280x720", "854x480"],
  "9:16": ["1080x1920", "720x1280", "480x854"],
  "1:1": ["1080x1080", "720x720", "480x480"],
};

const generationResolutionOptions: Array<{ value: GenerationResolution; label: string }> = [
  { value: "platform-default", label: "平台默认" },
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "768p", label: "768p" },
  { value: "1080p", label: "1080p" },
];

function windowsFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

function RefreshWarning({ message }: { message: string | null }) {
  return message ? <div className="refresh-warning" role="status" aria-live="polite">! {message}</div> : null;
}

function WorkspaceLoadFailure({ message, retrying, onRetry, onBack }: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="empty-state workspace-load-failure" role="alert">
      <strong>工作区读取失败</strong>
      <p>{message}</p>
      <div className="workspace-load-actions">
        <button className="secondary" type="button" disabled={retrying} onClick={onBack}>返回项目总览</button>
        <button className="primary" type="button" disabled={retrying} onClick={onRetry}>{retrying ? "正在重试…" : "重新读取"}</button>
      </div>
    </div>
  );
}

function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void, closeDisabled = false) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  closeRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const focusTimer = window.setTimeout(() => {
      (dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusableElements()[0] ?? dialog).focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabledRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  return dialogRef;
}

function useRequestEpoch() {
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current += 1; }, []);
  return epoch;
}

interface StoredStageDraft {
  baseArtifactId: string | null;
  expectedLatestArtifactId: string | null;
  editor: string;
  shotDraft: ShotSpec | null;
  savedAt: string;
}

function isRecoverableShotDraft(value: unknown): value is ShotSpec {
  if (!value || typeof value !== "object") return false;
  const shot = value as Partial<ShotSpec>;
  const camera = shot.camera as Partial<ShotSpec["camera"]> | undefined;
  return typeof shot.id === "string"
    && typeof shot.purpose === "string"
    && typeof shot.shotSize === "string"
    && typeof shot.action === "string"
    && typeof shot.startState === "string"
    && typeof shot.endState === "string"
    && typeof shot.sceneId === "string"
    && Number.isFinite(shot.startTimeSec)
    && Number.isFinite(shot.endTimeSec)
    && Array.isArray(shot.characterIds)
    && Array.isArray(shot.propIds)
    && Array.isArray(shot.styleIds)
    && typeof camera?.position === "string"
    && typeof camera?.movement === "string";
}

function stageDraftStorageKey(projectId: string, type: ArtifactType): string {
  return `ai-video-studio:stage-draft:${projectId}:${type}`;
}

function readStoredStageDraft(projectId: string, type: ArtifactType): StoredStageDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(stageDraftStorageKey(projectId, type));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredStageDraft>;
    if (typeof value.editor !== "string" || typeof value.savedAt !== "string") return null;
    const baseArtifactId = typeof value.baseArtifactId === "string" ? value.baseArtifactId : null;
    return {
      baseArtifactId,
      expectedLatestArtifactId: recoverDraftExpectedLatestArtifactId(value.expectedLatestArtifactId, baseArtifactId),
      editor: value.editor,
      shotDraft: isRecoverableShotDraft(value.shotDraft) ? value.shotDraft : null,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [integrityByProjectId, setIntegrityByProjectId] = useState<Record<string, ProjectIntegrityAudit>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [archiveCandidate, setArchiveCandidate] = useState<Project | null>(null);
  const [archiveManagerOpen, setArchiveManagerOpen] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [view, setView] = useState<"dashboard" | "assets" | ProjectWorkbenchView>("dashboard");
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState(false);
  const [foregroundRefreshRevision, setForegroundRefreshRevision] = useState(0);
  const selectedIdRef = useRef(selectedId);
  const projectsRef = useRef(projects);
  const applicationRefreshEpoch = useRef(0);
  const archiveLoadEpoch = useRef(0);
  const viewRef = useRef(view);
  const stageEditStateRef = useRef<{ projectId: string; type: ArtifactType; dirty: boolean } | null>(null);
  selectedIdRef.current = selectedId;
  projectsRef.current = projects;
  viewRef.current = view;

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );
  const selectedIntegrity = selected ? integrityByProjectId[selected.id] ?? null : null;
  const selectedStageGroupIndex = selected ? selectedStepIndex : -1;
  const selectedStep = selected ? projectWorkbenchSteps[selectedStepIndex] : null;

  function openProjectStep(index: number) {
    const step = projectWorkbenchSteps[index];
    if (!step) return;
    setSelectedStepIndex(index);
    setView(step.view);
  }

  function openProjectStepById(stepId: ProjectIntegrityStepId) {
    const index = projectWorkbenchSteps.findIndex((step) => step.id === stepId);
    openProjectStep(index < 0 ? 0 : index);
  }

  function openCurrentProjectStep(project: Project) {
    const blockedStepId = integrityByProjectId[project.id]?.firstBlockedStepId;
    if (blockedStepId) openProjectStepById(blockedStepId);
    else openProjectStep(currentProjectStepIndex(project.currentStage));
  }

  useEffect(() => {
    let active = true;
    const refreshApplication = async (initial: boolean) => {
      if (!initial && document.visibilityState !== "visible") return;
      const sequence = ++applicationRefreshEpoch.current;
      const [projectResult, healthResult] = await Promise.allSettled([api.listProjects(), api.health()]);
      const integrityResults = projectResult.status === "fulfilled"
        ? await Promise.allSettled(projectResult.value.projects.map((project) => api.getProjectIntegrity(project.id)))
        : [];
      if (!active || sequence !== applicationRefreshEpoch.current) return;
      const failures: string[] = [];
      if (projectResult.status === "fulfilled") {
        const remoteProjects = projectResult.value.projects;
        const reconciled = reconcileProjectSelection(remoteProjects, selectedIdRef.current);
        let nextProjects = remoteProjects;
        const stageEdit = stageEditStateRef.current;
        const localProject = projectsRef.current.find((project) => project.id === stageEdit?.projectId);
        const remoteProject = remoteProjects.find((project) => project.id === stageEdit?.projectId);
        if (viewRef.current === "stage" && stageEdit?.dirty && localProject && remoteProject
          && remoteProject.currentStage !== localProject.currentStage
          && artifactTypeForStage(remoteProject.currentStage) !== stageEdit.type) {
          nextProjects = remoteProjects.map((project) => project.id === localProject.id ? localProject : project);
          failures.push("另一个标签页已推进到不同制作阶段；当前未保存草稿已保留，本页不会自动切换阶段。请先另存或返回总览放弃草稿");
        }
        projectsRef.current = nextProjects;
        setProjects(nextProjects);
        const nextIntegrity: Record<string, ProjectIntegrityAudit> = {};
        integrityResults.forEach((result, index) => {
          if (result.status === "fulfilled") nextIntegrity[remoteProjects[index].id] = result.value.audit;
          else failures.push(`${remoteProjects[index].title} 的完整性审计读取失败`);
        });
        setIntegrityByProjectId(nextIntegrity);
        selectedIdRef.current = reconciled.selectedId;
        setSelectedId(reconciled.selectedId);
        if (initial) {
          const initialProject = remoteProjects.find((project) => project.id === reconciled.selectedId);
          const initialAudit = initialProject ? nextIntegrity[initialProject.id] : null;
          if (initialProject) {
            const blockedIndex = initialAudit?.firstBlockedStepId
              ? projectWorkbenchSteps.findIndex((step) => step.id === initialAudit.firstBlockedStepId)
              : -1;
            setSelectedStepIndex(blockedIndex >= 0 ? blockedIndex : currentProjectStepIndex(initialProject.currentStage));
          }
        }
        if (reconciled.selectionLost) {
          setView("dashboard");
          failures.push("当前项目已在另一个标签页归档或移除，已退出原功能页并切换到可用项目");
        }
        if (!initial) setForegroundRefreshRevision((current) => current + 1);
      } else {
        failures.push(projectResult.reason instanceof Error ? projectResult.reason.message : "项目列表加载失败");
      }
      if (healthResult.status === "fulfilled") {
        setHealth(healthResult.value);
      } else {
        setHealth(null);
        failures.push(healthResult.reason instanceof Error ? healthResult.reason.message : "服务状态加载失败");
      }
      setSyncError(failures.length ? failures.join("；") : null);
      setLoading(false);
    };
    void refreshApplication(true);
    const onVisibilityChange = () => {
      if (shouldSkipForegroundRefreshForFilePicker(document.activeElement as HTMLInputElement | null)) return;
      void refreshApplication(false);
    };
    window.addEventListener("focus", onVisibilityChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.removeEventListener("focus", onVisibilityChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (error || syncError) setDetailMode(true);
  }, [error, syncError]);

  async function handleCreate(input: CreateProjectInput) {
    const { project } = await api.createProject(input);
    applicationRefreshEpoch.current += 1;
    const nextProjects = [project, ...projectsRef.current.filter((item) => item.id !== project.id)];
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    selectedIdRef.current = project.id;
    setSelectedId(project.id);
    setLoading(false);
    setSelectedStepIndex(currentProjectStepIndex(project.currentStage));
    setView("dashboard");
    void api.getProjectIntegrity(project.id).then(({ audit }) => {
      setIntegrityByProjectId((current) => ({ ...current, [project.id]: audit }));
    }).catch(() => undefined);
  }

  function updateProject(project: Project) {
    applicationRefreshEpoch.current += 1;
    const nextProjects = projectsRef.current.map((item) => item.id === project.id ? project : item);
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    void api.getProjectIntegrity(project.id).then(({ audit }) => {
      setIntegrityByProjectId((current) => ({ ...current, [project.id]: audit }));
    }).catch((reason: Error) => setSyncError(`完整性审计刷新失败：${reason.message}`));
  }

  async function handleArchive(projectId: string) {
    const { project } = await api.archiveProject(projectId);
    applicationRefreshEpoch.current += 1;
    const remaining = projectsRef.current.filter((item) => item.id !== projectId);
    projectsRef.current = remaining;
    setProjects(remaining);
    setIntegrityByProjectId((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    setArchivedProjects((current) => [project, ...current.filter((item) => item.id !== projectId)]);
    const nextSelectedId = selectedIdRef.current === projectId ? remaining[0]?.id ?? null : selectedIdRef.current;
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
    if (remaining[0]) setSelectedStepIndex(currentProjectStepIndex(remaining[0].currentStage));
    setArchiveCandidate(null);
    setView("dashboard");
  }

  async function openArchiveManager() {
    const epoch = ++archiveLoadEpoch.current;
    setArchiveManagerOpen(true);
    setArchiveLoading(true);
    try {
      const result = await api.listArchivedProjects();
      if (epoch !== archiveLoadEpoch.current) return;
      setArchivedProjects(result.projects);
    } catch (reason) {
      if (epoch !== archiveLoadEpoch.current) return;
      setError(reason instanceof Error ? reason.message : "读取归档项目失败");
    } finally {
      if (epoch === archiveLoadEpoch.current) setArchiveLoading(false);
    }
  }

  function closeArchiveManager() {
    archiveLoadEpoch.current += 1;
    setArchiveLoading(false);
    setArchiveManagerOpen(false);
  }

  async function handleRestore(projectId: string) {
    archiveLoadEpoch.current += 1;
    const { project } = await api.restoreProject(projectId);
    applicationRefreshEpoch.current += 1;
    setArchivedProjects((current) => current.filter((item) => item.id !== projectId));
    const nextProjects = [project, ...projectsRef.current.filter((item) => item.id !== projectId)];
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    selectedIdRef.current = project.id;
    setSelectedId(project.id);
    setLoading(false);
    setSelectedStepIndex(currentProjectStepIndex(project.currentStage));
    setArchiveLoading(false);
    setArchiveManagerOpen(false);
    setView("dashboard");
    void api.getProjectIntegrity(project.id).then(({ audit }) => {
      setIntegrityByProjectId((current) => ({ ...current, [project.id]: audit }));
    }).catch(() => undefined);
  }

  return (
    <div className={`app-shell ${detailMode ? "detail-mode" : "simple-mode"}`}>
      <header className="topbar">
        <button className="brand" onClick={() => { const project = projects[0]; setSelectedId(project?.id ?? null); if (project) setSelectedStepIndex(currentProjectStepIndex(project.currentStage)); setView("dashboard"); }}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>AI VIDEO</strong><small>STUDIO / LOCAL</small></span>
        </button>

        <nav className="main-nav" aria-label="主导航">
          <button className={view === "dashboard" || view === "source" || view === "stage" ? "active" : ""} onClick={() => selected ? openCurrentProjectStep(selected) : setView("dashboard")}>项目工作台</button>
          <button className={view === "assets" ? "active" : ""} disabled={!selected} onClick={() => setView("assets")}>素材库</button>
          <button className={view === "generation" ? "active" : ""} disabled={!selected} onClick={() => openProjectStep(6)}>生成中心</button>
          <button className={view === "quality" ? "active" : ""} disabled={!selected} onClick={() => openProjectStep(7)}>质量审核</button>
          <button className={view === "delivery" ? "active" : ""} disabled={!selected} onClick={() => openProjectStep(8)}>成片交付</button>
        </nav>

        <div className="top-actions">
          <span className={`local-state ${health?.ok ? "online" : "offline"}`}>
            <i />{health?.ok ? "本地服务在线" : loading ? "正在连接" : "本地服务离线"}
          </span>
          <button className={`secondary compact detail-mode-toggle ${detailMode ? "active" : ""}`} aria-pressed={detailMode} onClick={() => setDetailMode((current) => !current)}>{detailMode ? "✓ 返回简洁流程" : "发现问题 / 详细处理"}</button>
          <button className="secondary compact" onClick={() => void openArchiveManager()}>已归档</button>
          <button className="primary compact" onClick={() => setModalOpen(true)}>＋ 新建项目</button>
        </div>
      </header>

      {(error || syncError) && <div className="error-banner" role="alert" aria-live="assertive">{error ?? syncError}<button type="button" onClick={() => { setError(null); setSyncError(null); }}>关闭</button></div>}

      <div className={`workspace ${view !== "dashboard" ? "workbench-mode" : ""}`}>
        <aside className="stage-sidebar">
          <div className="sidebar-heading">
            <span>PRODUCTION FLOW</span>
            <small>{selected
              ? `正在查看 ${String(Math.max(0, selectedStageGroupIndex) + 1).padStart(2, "0")}`
              : "未选择项目"}</small>
          </div>
          <div className="stage-list">
            {stageGroups.map((group, index) => {
              const state = selected ? projectStepState(selected, index, selectedIntegrity) : "future";
              const integrityIssueCount = selectedIntegrity?.issues.filter((issue) => issue.stepId === group.id && issue.severity === "error").length ?? 0;
              const firstBlockedIndex = selectedIntegrity?.firstBlockedStepId
                ? projectWorkbenchSteps.findIndex((step) => step.id === selectedIntegrity.firstBlockedStepId)
                : -1;
              const blockedByUpstream = Boolean(selected && firstBlockedIndex >= 0 && index > firstBlockedIndex && index <= currentProjectStepIndex(selected.currentStage));
              const isSelected = selected && selectedStepIndex === index && view !== "dashboard" && view !== "assets";
              return (
                <button type="button" disabled={!selected} className={`stage-item ${state} ${isSelected ? "selected" : ""}`} key={group.label} aria-current={isSelected ? "step" : undefined} onClick={() => openProjectStep(index)}>
                  <span className="stage-number">{String(index + 1).padStart(2, "0")}</span>
                  <span><strong>{group.label}</strong><small>{integrityIssueCount ? `需要处理 · ${integrityIssueCount} 项` : blockedByUpstream ? "上游证据未通过" : projectStepStateLabels[state]}</small></span>
                  <b>{state === "done" ? "↗" : state === "needs-update" ? "!" : isSelected ? "→" : "·"}</b>
                </button>
              );
            })}
          </div>
          <div className="safety-card">
            <span className="eyebrow">COST GUARD</span>
            <strong>付费视频 API 已关闭</strong>
            <p>当前只生成本地项目数据与人工投递包。</p>
          </div>
        </aside>

        <main className="main-canvas">
          {loading ? (
            <div className="empty-state"><div className="loader" /><p>正在恢复本地项目…</p></div>
          ) : selected && view === "source" ? (
            <SourceWorkspace key={selected.id} project={selected} onBack={() => setView("dashboard")} onOpenOutline={() => openProjectStep(1)} onError={setError} />
          ) : selected && view === "stage" ? (
            <StageWorkspace key={`${selected.id}:${selectedStep?.artifactType ?? "unknown"}`} project={selected} type={selectedStep?.artifactType ?? artifactTypeForStage(selected.currentStage)} refreshRevision={foregroundRefreshRevision} onBack={() => setView("dashboard")} onOpenGeneration={() => openProjectStep(6)} onProjectUpdate={updateProject} onError={setError} onEditStateChange={(state) => { stageEditStateRef.current = state; }} />
          ) : selected && view === "assets" ? (
            <AssetLibraryWorkspace key={selected.id} project={selected} refreshRevision={foregroundRefreshRevision} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "generation" ? (
            <GenerationCenterWorkspace key={selected.id} project={selected} refreshRevision={foregroundRefreshRevision} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "quality" ? (
            <QualityReviewWorkspace key={selected.id} project={selected} refreshRevision={foregroundRefreshRevision} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "delivery" ? (
            <DeliveryWorkspace key={selected.id} project={selected} refreshRevision={foregroundRefreshRevision} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onDelivered={() => openProjectStep(8)} onError={setError} />
          ) : selected ? (
            <ProjectDashboard project={selected} projects={projects} integrity={selectedIntegrity} integrityByProjectId={integrityByProjectId} refreshRevision={foregroundRefreshRevision} onSelect={(id) => { const project = projects.find((item) => item.id === id); const blockedStepId = integrityByProjectId[id]?.firstBlockedStepId; setSelectedId(id); if (blockedStepId) setSelectedStepIndex(projectWorkbenchSteps.findIndex((step) => step.id === blockedStepId)); else if (project) setSelectedStepIndex(currentProjectStepIndex(project.currentStage)); setView("dashboard"); }} onCreate={() => setModalOpen(true)} onArchive={() => setArchiveCandidate(selected)} onOpenStep={openProjectStepById} onOpenStage={() => openCurrentProjectStep(selected)} onOpenGeneration={() => openProjectStep(6)} onOpenQuality={() => openProjectStep(7)} onOpenDelivery={() => openProjectStep(8)} />
          ) : (
            <EmptyStudio onCreate={() => setModalOpen(true)} />
          )}
        </main>

        <aside className="context-panel">
          <div className="panel-title"><span>项目检查</span><small>CONTEXT</small></div>
          {selected ? <ContextChecks project={selected} health={health} /> : <p className="muted">创建项目后显示前置条件、引用与风险。</p>}
        </aside>
      </div>

      {modalOpen && <CreateProjectModal onClose={() => setModalOpen(false)} onCreate={handleCreate} />}
      {archiveCandidate && <ArchiveProjectModal project={archiveCandidate} onClose={() => setArchiveCandidate(null)} onArchive={handleArchive} />}
      {archiveManagerOpen && <ArchivedProjectsModal projects={archivedProjects} loading={archiveLoading} onClose={closeArchiveManager} onRestore={handleRestore} />}
    </div>
  );
}

function EmptyStudio({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-hero">
      <span className="eyebrow">LOCAL-FIRST PRODUCTION SYSTEM</span>
      <h1>把故事变成<br /><em>可追溯的镜头。</em></h1>
      <p>从原始故事、剧本、导演脚本或分镜任意阶段接入。所有原件、审批和版本都留在本机。</p>
      <div className="hero-actions">
        <button className="primary" onClick={onCreate}>创建第一个项目 <span>→</span></button>
        <span><b>0</b> 自动付费调用</span>
      </div>
      <div className="flow-preview">
        {["故事", "剧本", "资产", "导演脚本", "分镜", "生成", "质检", "交付"].map((item, index) => (
          <div key={item}><small>{String(index + 1).padStart(2, "0")}</small><strong>{item}</strong></div>
        ))}
      </div>
    </section>
  );
}

function SourceWorkspace({ project, onBack, onOpenOutline, onError }: {
  project: Project;
  onBack: () => void;
  onOpenOutline: () => void;
  onError: (message: string | null) => void;
}) {
  const [source, setSource] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.getSource(project.id)
      .then((result) => {
        if (!active) return;
        setSource(result.sourceText);
        setSourcePath(result.sourcePath);
      })
      .catch((reason: Error) => { if (active) onError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id]);

  return (
    <section className="source-workspace">
      <div className="workbench-head">
        <div><button className="back-link" onClick={onBack}>← 返回项目总览</button><span className="eyebrow">PROJECT SOURCE</span><h1>{project.title} · 原始内容</h1><p>原始输入始终可以回顾；它作为审计原件保留，不会因后续修订消失。</p></div>
        <button className="primary" onClick={onOpenOutline}>查看剧情大纲 →</button>
      </div>
      <div className="source-overview-grid">
        <article className="source-document-card">
          <header><div><span>ORIGINAL V001</span><strong>项目原始输入</strong></div><b>只读原件</b></header>
          {loading ? <div className="empty-state"><div className="loader mini" /><p>正在读取原始内容…</p></div> : <pre>{source}</pre>}
          <code title={sourcePath}>{sourcePath}</code>
        </article>
        <aside className="source-project-facts">
          <span className="eyebrow">PROJECT CONTRACT</span>
          <h2>项目约束</h2>
          <dl>
            <div><dt>输入类型</dt><dd>{sourceLabels[project.sourceType]}</dd></div>
            <div><dt>目标时长</dt><dd>{project.targetDurationSec} 秒</dd></div>
            <div><dt>画幅与输出</dt><dd>{project.aspectRatio} · {project.resolution}</dd></div>
            <div><dt>视频类型</dt><dd>{project.videoType || "未填写"}</dd></div>
            <div><dt>视觉风格</dt><dd>{project.visualStyle || "未填写"}</dd></div>
            <div><dt>当前进度</dt><dd>{stageLabels[project.currentStage]}</dd></div>
          </dl>
          <p>需要改变故事内容时，请进入大纲或剧本创建修订版本。旧内容继续保留，受影响的后续步骤会明确标记为“需要更新”。</p>
        </aside>
      </div>
    </section>
  );
}

function ProjectDashboard({ project, projects, integrity, integrityByProjectId, refreshRevision, onSelect, onCreate, onArchive, onOpenStep, onOpenStage, onOpenGeneration, onOpenQuality, onOpenDelivery }: {
  project: Project;
  projects: Project[];
  integrity: ProjectIntegrityAudit | null;
  integrityByProjectId: Record<string, ProjectIntegrityAudit>;
  refreshRevision: number;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: () => void;
  onOpenStep: (stepId: ProjectIntegrityStepId) => void;
  onOpenStage: () => void;
  onOpenGeneration: () => void;
  onOpenQuality: () => void;
  onOpenDelivery: () => void;
}) {
  const [assetCount, setAssetCount] = useState<number | null>(null);
  const [shotCount, setShotCount] = useState<number | null>(null);
  const [renderCount, setRenderCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setAssetCount(null);
    setShotCount(null);
    setRenderCount(null);
    void Promise.allSettled([api.listAssets(project.id), api.listShots(project.id), api.qualityCenter(project.id)]).then(([assetResult, shotResult, qualityResult]) => {
      if (!active) return;
      setAssetCount(assetResult.status === "fulfilled" ? assetResult.value.assets.length : null);
      setShotCount(shotResult.status === "fulfilled" ? shotResult.value.shots.length : null);
      setRenderCount(qualityResult.status === "fulfilled" ? qualityResult.value.renders.length : null);
    });
    return () => { active = false; };
  }, [project.id, project.updatedAt, refreshRevision]);
  const currentPosition = allStages.indexOf(project.currentStage);
  const claimedProgress = Math.max(4, Math.round(((currentPosition + 1) / allStages.length) * 100));
  const firstBlockedIndex = integrity?.firstBlockedStepId
    ? projectWorkbenchSteps.findIndex((step) => step.id === integrity.firstBlockedStepId)
    : -1;
  const progress = integrity?.status === "blocked" && firstBlockedIndex >= 0
    ? Math.min(claimedProgress, Math.max(4, Math.round((firstBlockedIndex / projectWorkbenchSteps.length) * 100)))
    : claimedProgress;
  const integrityErrors = integrity?.issues.filter((issue) => issue.severity === "error") ?? [];
  const firstIntegrityError = integrityErrors[0] ?? null;
  const stageFocusTitle = project.currentStage === "SOURCE_IMPORTED"
    ? "原始内容已安全入库"
    : project.currentStage === "OUTLINE_APPROVED"
      ? "剧情大纲已批准，准备生成影视剧本"
      : project.currentStage === "SCREENPLAY_APPROVED"
        ? "影视剧本已批准，准备提取逻辑资产"
        : project.currentStage === "ASSET_BIBLE_APPROVED"
          ? "资产定义已批准，准备生成 ShotSpec"
          : project.currentStage === "SHOOTING_SCRIPT_APPROVED"
            ? "导演脚本已批准，准备设计分镜"
            : project.currentStage === "STORYBOARD_APPROVED"
              ? "Phase 3 已完成"
              : (["ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING"] as ProjectStage[]).includes(project.currentStage)
                ? "继续生成和导入镜头"
                : project.currentStage === "GENERATION_REVIEW"
                  ? "审核已经导入的镜头"
                  : project.currentStage === "EDITING"
                    ? "创建新的本地粗剪"
                    : project.currentStage === "FINAL_REVIEW"
                      ? "粗剪已生成，等待成片终审"
                      : project.currentStage === "DELIVERED"
                        ? "交付版本已经创建"
                        : "继续当前人工审核";
  const stageFocusBody = project.currentStage === "SOURCE_IMPORTED"
    ? "系统已保存不可变原件。下一步将生成剧情诊断与大纲草案，未经批准不会进入影视剧本。"
    : project.currentStage === "OUTLINE_APPROVED"
      ? "大纲文件及审批哈希已经锁定。进入当前阶段后，可以启动影视剧本生成。"
      : project.currentStage === "SCREENPLAY_APPROVED"
        ? "大纲和影视剧本均已通过人工审批，下一阶段将继续资产定义。"
        : project.currentStage === "ASSET_BIBLE_APPROVED"
          ? "逻辑资产身份已经锁定，下一阶段将生成连续时间码导演脚本。"
          : project.currentStage === "SHOOTING_SCRIPT_APPROVED"
            ? "ShotSpec 已通过结构校验和人工审批，下一阶段将设计分镜并运行连续性检查。"
            : project.currentStage === "STORYBOARD_APPROVED"
              ? "资产、导演脚本、分镜和连续性报告已经形成批准版本。"
              : (["ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING"] as ProjectStage[]).includes(project.currentStage)
                ? "继续生成逐镜头投递包，或扫描已经下载到收件箱的视频。"
                : project.currentStage === "GENERATION_REVIEW"
                  ? "逐段播放视频：正常就一键通过，出现问题再进入详细处理。"
                  : project.currentStage === "EDITING"
                    ? "已通过镜头保持不变；按顺序合并并创建不可覆盖的新粗剪版本。"
                    : project.currentStage === "FINAL_REVIEW"
                      ? "播放完整粗剪，正常就直接批准并创建交付版本。"
                      : project.currentStage === "DELIVERED"
                        ? "可查看、播放和下载已批准的成片、字幕及交付报告。"
                        : "当前版本等待你的明确批准或驳回；系统不会自动越过人工门禁。";
  const focusTitle = firstIntegrityError
    ? `项目“${stageLabels[project.currentStage]}”状态不可采信`
    : stageFocusTitle;
  const focusBody = firstIntegrityError
    ? `系统在“${projectWorkbenchSteps.find((step) => step.id === firstIntegrityError.stepId)?.label ?? firstIntegrityError.stepId}”发现证据缺口：${firstIntegrityError.message}。先修复这一环节，后续完成标记不会再被当成有效结果。`
    : stageFocusBody;
  const stageDashboardAction = project.currentStage === "GENERATION_REVIEW"
    ? { label: "进入视频审核", run: onOpenQuality }
    : project.currentStage === "EDITING"
      ? { label: "进入粗剪处理", run: onOpenQuality }
      : (["FINAL_REVIEW", "DELIVERED"] as ProjectStage[]).includes(project.currentStage)
        ? { label: project.currentStage === "DELIVERED" ? "查看交付文件" : "进入成片终审", run: onOpenDelivery }
        : (["STORYBOARD_APPROVED", "ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING"] as ProjectStage[]).includes(project.currentStage)
          ? { label: "进入生成中心", run: onOpenGeneration }
          : { label: "进入当前阶段", run: onOpenStage };
  const dashboardAction = integrity?.firstBlockedStepId
    ? { label: `处理第 ${String(firstBlockedIndex + 1).padStart(2, "0")} 步`, run: () => onOpenStep(integrity.firstBlockedStepId!) }
    : stageDashboardAction;
  return (
    <section className="project-dashboard">
      <div className="project-heading">
        <div>
          <span className="eyebrow">ACTIVE PROJECT / {project.id.slice(0, 8).toUpperCase()}</span>
          <h1>{project.title}</h1>
          <p>{sourceLabels[project.sourceType]} · {project.targetDurationSec} 秒 · {project.aspectRatio} · {project.resolution}</p>
        </div>
        <div className="project-switcher">
          <select value={project.id} onChange={(event) => onSelect(event.target.value)} aria-label="切换项目">
            {projects.map((item) => {
              const issueCount = integrityByProjectId[item.id]?.issues.filter((issue) => issue.severity === "error").length ?? 0;
              return <option key={item.id} value={item.id}>{issueCount ? `⚠ ${item.title}（${issueCount} 项）` : item.title}</option>;
            })}
          </select>
          <button className="secondary" onClick={onCreate}>新项目</button>
          <button className="secondary danger" onClick={onArchive}>删除项目</button>
        </div>
      </div>

      {integrity?.status === "blocked" && (
        <div className="integrity-alert" role="alert">
          <div><span>PROJECT EVIDENCE AUDIT</span><strong>检测到 {integrityErrors.length} 项证据缺口，当前“{stageLabels[project.currentStage]}”不能作为完成依据</strong></div>
          <button className="secondary" type="button" onClick={() => integrity.firstBlockedStepId && onOpenStep(integrity.firstBlockedStepId)}>打开最早问题步骤</button>
          <ul>{integrityErrors.slice(0, 6).map((issue) => <li key={`${issue.stepId}:${issue.code}:${issue.message}`}><b>{projectWorkbenchSteps.find((step) => step.id === issue.stepId)?.label ?? issue.stepId}</b> · {issue.message}</li>)}</ul>
          {integrityErrors.length > 6 && <small>还有 {integrityErrors.length - 6} 项；进入对应步骤查看并处理。</small>}
        </div>
      )}

      <div className="progress-card">
        <div className="progress-top"><span>{integrity?.status === "blocked" ? "已核验证据进度" : "总流程进度"}</span><strong>{progress}%</strong></div>
        <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
        <div className="progress-meta"><span>当前记录：{stageLabels[project.currentStage]}</span><span>{integrity?.status === "blocked" ? "完成标签已被证据审计否决" : "本地证据审计通过"}</span></div>
      </div>

      <div className="metric-grid">
        <Metric icon="⌁" label="需要处理" value={String(integrityErrors.length || (project.currentStage.endsWith("_REVIEW") ? 1 : 0))} detail={integrityErrors.length ? "证据缺口" : "当前阶段门禁"} accent="violet" />
        <Metric icon="◫" label="素材资产" value={assetCount == null ? "—" : String(assetCount)} detail={assetCount == null ? "读取失败或等待重试" : assetCount ? "逻辑资产" : "等待资产定义"} accent="cyan" />
        <Metric icon="▶" label="镜头计划" value={shotCount == null ? "—" : String(shotCount)} detail={shotCount == null ? "读取失败或等待重试" : shotCount ? "结构化 ShotSpec" : "等待导演脚本"} accent="amber" />
        <Metric icon="✓" label="交付版本" value={renderCount == null ? "—" : String(renderCount)} detail={renderCount == null ? "读取失败或等待重试" : "历史永不覆盖"} accent="green" />
      </div>

      <div className="content-grid">
        <article className="focus-card">
          <div className="card-kicker"><span>当前工作</span><small>{stageLabels[project.currentStage]}</small></div>
          <h2>{focusTitle}</h2>
          <p>{focusBody}</p>
          <div className="focus-actions">
            <button className="primary" onClick={dashboardAction.run}>{dashboardAction.label} <span>→</span></button>
            <button className="secondary" onClick={() => void navigator.clipboard.writeText(project.projectDir)}>复制项目路径</button>
          </div>
          <div className="source-strip">
            <Icon>TXT</Icon><span><strong>original-v001.txt</strong><small>不可变原始文件 · 已归档</small></span><b>LOCKED</b>
          </div>
        </article>

        <article className="activity-card">
          <div className="card-kicker"><span>最近活动</span><small>LOCAL LOG</small></div>
          <div className="activity-item"><i /><span><strong>项目创建完成</strong><small>{new Date(project.createdAt).toLocaleString("zh-CN")}</small></span></div>
          <div className="activity-item muted"><i /><span><strong>{project.currentStage === "SOURCE_IMPORTED" ? "等待下一阶段" : stageLabels[project.currentStage]}</strong><small>{project.currentStage === "SOURCE_IMPORTED" ? "尚未运行文字智能任务" : `最近更新：${new Date(project.updatedAt).toLocaleString("zh-CN")}`}</small></span></div>
          <div className="activity-footer">运行记录保存在项目 logs 目录</div>
        </article>
      </div>
    </section>
  );
}

const artifactLabels: Record<ArtifactType, string> = {
  outline: "剧情大纲",
  screenplay: "影视剧本",
  "asset-bible": "资产定义",
  "shooting-script": "导演脚本",
  storyboard: "分镜设计",
};
const generationRoutes: Record<ArtifactType, string> = {
  outline: "producer → story-architect",
  screenplay: "producer → screenplay-writer",
  "asset-bible": "producer → asset-bible-builder",
  "shooting-script": "producer → shooting-script-director",
  storyboard: "producer → storyboard-director → continuity-supervisor",
};
const generationExpectations: Record<ArtifactType, string> = {
  outline: "通常 30 秒–2 分钟",
  screenplay: "通常 1–3 分钟",
  "asset-bible": "通常 2–8 分钟；最长等待 12 分钟",
  "shooting-script": "通常 1–4 分钟",
  storyboard: "分镜草案通常 2–5 分钟；草案会先保存，连续性审核单独运行且最长等待 4 分钟",
};

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
}

function missingRoughCutCapabilities(status: MediaToolStatus): string[] {
  return [
    !status.ffmpegAvailable ? "FFmpeg" : null,
    !status.ffprobeAvailable ? "ffprobe" : null,
    status.ffmpegAvailable && !status.libx264Available ? "libx264" : null,
    status.ffmpegAvailable && !status.aacAvailable ? "AAC" : null,
  ].filter((item): item is string => Boolean(item));
}

const assetDesignModeLabels: Record<AssetDesignMode, { title: string; detail: string }> = {
  "original-proposal": { title: "原创完整设定（推荐）", detail: "对剧本未写明的外观作出明确、可修改的原创方案，不再留下人物空壳。" },
  "reference-first": { title: "忠于已有文本／参考图", detail: "不补写无依据的造型；缺失项保持锁定，等待你上传人物图或补充文字。" },
};

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function assetNeedsDesign(asset: Asset): boolean {
  if (asset.type === "audio") return false;
  return !asset.productionReady && !asset.localFiles.length;
}

const reviewStageByArtifact: Record<ArtifactType, ProjectStage> = {
  outline: "OUTLINE_REVIEW",
  screenplay: "SCREENPLAY_REVIEW",
  "asset-bible": "ASSET_BIBLE_REVIEW",
  "shooting-script": "SHOOTING_SCRIPT_REVIEW",
  storyboard: "STORYBOARD_REVIEW",
};
const artifactStatusLabels: Record<Artifact["status"], string> = {
  draft: "待审核",
  approved: "已批准",
  rejected: "已驳回",
  stale: "已过期",
};

function artifactTypeForStage(stage: ProjectStage): ArtifactType {
  if ((["SOURCE_IMPORTED", "OUTLINE_REVIEW", "OUTLINE_APPROVED"] as ProjectStage[]).includes(stage)) return "outline";
  if ((["SCREENPLAY_REVIEW", "SCREENPLAY_APPROVED"] as ProjectStage[]).includes(stage)) return "screenplay";
  if ((["ASSET_BIBLE_REVIEW", "ASSET_BIBLE_APPROVED"] as ProjectStage[]).includes(stage)) return "asset-bible";
  if ((["SHOOTING_SCRIPT_REVIEW", "SHOOTING_SCRIPT_APPROVED"] as ProjectStage[]).includes(stage)) return "shooting-script";
  return "storyboard";
}

function extractSuggestions(content: string): string {
  const match = content.match(/# 可选修改建议\s*\n([\s\S]*?)(?=\n#\s|$)/);
  return match?.[1]?.trim() || "当前版本没有单独提出剧情修改建议。";
}

function artifactSkills(artifact: Artifact | null): SkillProvenance[] {
  const skills = artifact?.metadata.skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((skill): skill is SkillProvenance => {
    if (!skill || typeof skill !== "object") return false;
    const candidate = skill as Partial<SkillProvenance>;
    return typeof candidate.name === "string" && typeof candidate.version === "string" && typeof candidate.sha256 === "string";
  });
}

function artifactGenerationReadiness(artifact: Artifact | null): GenerationReadiness | null {
  const value = artifact?.metadata.generationReadiness;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GenerationReadiness>;
  if ((candidate.status !== "ready" && candidate.status !== "blocked") || !Array.isArray(candidate.issues)) return null;
  return candidate as GenerationReadiness;
}

function GenerationCenterWorkspace({ project, refreshRevision, onBack, onProjectUpdate, onError }: {
  project: Project;
  refreshRevision: number;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const [center, setCenter] = useState<GenerationCenter | null>(null);
  const [qualityCenter, setQualityCenter] = useState<QualityCenter | null>(null);
  const [narrativeReadiness, setNarrativeReadiness] = useState<GenerationReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardFeedback, setClipboardFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [generationFeedback, setGenerationFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [copyingMaterialKey, setCopyingMaterialKey] = useState<string | null>(null);
  const [compilingShotId, setCompilingShotId] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [generationResolutionByShot, setGenerationResolutionByShot] = useState<Record<string, GenerationResolution>>({});
  const [batchProgress, setBatchProgress] = useState<{ shotId: string; index: number; total: number } | null>(null);
  const compilingShotIdRef = useRef<string | null>(null);
  const loadEpoch = useRequestEpoch();

  async function load(): Promise<boolean> {
    const epoch = ++loadEpoch.current;
    try {
      const [generationResult, qualityResult, readinessResult] = await Promise.all([
        api.generationCenter(project.id),
        api.qualityCenter(project.id),
        api.getGenerationReadiness(project.id),
      ]);
      if (epoch !== loadEpoch.current) return false;
      setCenter(generationResult);
      setQualityCenter(qualityResult);
      setNarrativeReadiness(readinessResult.readiness);
      return true;
    } catch (reason) {
      if (epoch !== loadEpoch.current) return false;
      throw reason;
    }
  }

  async function reload() {
    setLoading(true);
    setLoadError(null);
    onError(null);
    try {
      const applied = await load();
      if (applied) setLoading(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "生成中心读取失败";
      setLoadError(message);
      onError(message);
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [project.id, refreshRevision]);

  useEffect(() => {
    if (!clipboardFeedback) return;
    const timer = window.setTimeout(() => setClipboardFeedback(null), 2_800);
    return () => window.clearTimeout(timer);
  }, [clipboardFeedback]);

  useEffect(() => {
    if (!generationFeedback) return;
    const timer = window.setTimeout(() => setGenerationFeedback(null), 3_600);
    return () => window.clearTimeout(timer);
  }, [generationFeedback]);

  async function run(key: string, action: () => Promise<{ project?: Project; [key: string]: unknown }>, message: string) {
    setBusy(key);
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { refreshError } = await runMutationWithRefresh({
        mutate: action,
        onSuccess: (result) => { if (result.project) onProjectUpdate(result.project); },
        refresh: async () => { await load(); },
      });
      setNotice(message);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "生成中心"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function prepareGeneration() {
    if (!center) return;
    const plan = generationPreparationPlan(project.currentStage, Boolean(center.bootstrap));
    if (!plan.length) {
      setNotice("生成环境已经准备完成，无需重复锁定或创建初始化包。");
      return;
    }
    setBusy("prepare");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    let latestProject = project;
    const completed: string[] = [];
    try {
      for (const step of plan) {
        const result = step === "lock-assets"
          ? await api.lockAssets(project.id)
          : await api.createUpdreamBootstrap(project.id);
        latestProject = result.project;
        onProjectUpdate(latestProject);
        completed.push(step === "lock-assets" ? "素材锁定" : "初始化包");
      }
      await load();
      setNotice(`${completed.join("和")}已一键完成；现在可以批量生成缺失镜头包。`);
    } catch (reason) {
      onProjectUpdate(latestProject);
      onError(`${completed.length ? `${completed.join("和")}已完成，但` : ""}自动准备中断：${reason instanceof Error ? reason.message : "操作失败"}。可再次点击继续，已完成步骤不会重复。`);
    } finally {
      setBusy(null);
    }
  }

  async function rebuildShootingScriptWithPhysicalPlan() {
    if (busy || compilingShotIdRef.current) return;
    setBusy("rebuild-shooting-script");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const result = await api.generateArtifact(project.id, "shooting-script");
      onProjectUpdate(result.project);
      onBack();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "导演脚本重新生成失败");
    } finally {
      setBusy(null);
    }
  }

  async function restartNarrativeForReliability(targetDurationSec: number) {
    if (busy || compilingShotIdRef.current) return;
    const durationChanged = targetDurationSec !== project.targetDurationSec;
    const action = durationChanged
      ? `将项目从 ${project.targetDurationSec} 秒调整为 ${targetDurationSec} 秒，并从大纲重新生成`
      : `保持 ${project.targetDurationSec} 秒，但让旧内容失效并从大纲删减重做`;
    if (typeof window !== "undefined" && !window.confirm(`${action}。旧版本与审批历史会保留，但不能继续用于付费投递。是否继续？`)) return;
    setBusy("restart-narrative");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const result = await api.reviseTargetDuration(project.id, targetDurationSec, true);
      onProjectUpdate(result.project);
      onBack();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "剧情重做入口执行失败");
    } finally {
      setBusy(null);
    }
  }

  async function createMissingShotPackages() {
    if (!center) return;
    const candidates = packageCandidates(center.shots);
    if (!candidates.eligibleIds.length) {
      setNotice(candidates.blockedIds.length
        ? `没有可自动生成的镜头包；${candidates.blockedIds.join("、")} 需要先处理预检问题。`
        : "所有镜头包均已存在，不会重复生成版本。");
      return;
    }
    setBusy("batch-shots");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    let latestProject = project;
    const completed: string[] = [];
    const failures: string[] = [];
    for (const [index, shotId] of candidates.eligibleIds.entries()) {
      setBatchProgress({ shotId, index: index + 1, total: candidates.eligibleIds.length });
      try {
        const result = await api.createUpdreamShotPackage(project.id, shotId, generationResolutionByShot[shotId] ?? "platform-default");
        latestProject = result.project;
        completed.push(shotId);
      } catch (reason) {
        failures.push(`${shotId}：${reason instanceof Error ? reason.message : "生成失败"}`);
      }
    }
    onProjectUpdate(latestProject);
    try {
      await load();
    } catch (reason) {
      setRefreshWarning(formatRefreshWarning(reason instanceof Error ? reason : new Error("刷新失败"), "生成中心"));
    }
    const blockedCopy = candidates.blockedIds.length ? `；${candidates.blockedIds.join("、")} 因预检未通过而跳过` : "";
    setNotice(`批量任务完成：成功 ${completed.length}/${candidates.eligibleIds.length}${blockedCopy}。已有镜头包未重复生成。`);
    if (failures.length) onError(`部分镜头生成失败：${failures.join("；")}`);
    setBatchProgress(null);
    setBusy(null);
  }

  async function createShotPackage(shotId: string) {
    if (busy || compilingShotIdRef.current) return;
    compilingShotIdRef.current = shotId;
    const generationResolution = generationResolutionByShot[shotId] ?? "platform-default";
    const scrollTop = document.scrollingElement?.scrollTop ?? window.scrollY;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCompilingShotId(shotId);
    setGenerationFeedback(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.createUpdreamShotPackage(project.id, shotId, generationResolution),
        onSuccess: (result) => onProjectUpdate(result.project),
        refresh: async () => { await load(); },
      });
      setGenerationFeedback({ message: `${shotId} 新版本已生成，当前镜头内容已更新。`, error: false });
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "生成中心"));
    } catch (reason) {
      setGenerationFeedback({ message: reason instanceof Error ? reason.message : `${shotId} 新版本生成失败`, error: true });
    } finally {
      compilingShotIdRef.current = null;
      setCompilingShotId(null);
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: scrollTop, behavior: "auto" });
        const fallbackButton = document.querySelector<HTMLElement>(`[data-shot-generate="${shotId}"]`);
        if (focusedElement && document.contains(focusedElement)) focusedElement.focus({ preventScroll: true });
        else fallbackButton?.focus({ preventScroll: true });
      });
    }
  }

  async function copyPrompt(shotId: string, version: number) {
    setBusy(`copy:${shotId}:${version}`);
    try {
      const result = await api.readUpdreamPrompt(project.id, shotId, version);
      await navigator.clipboard.writeText(result.prompt);
      setNotice(`${shotId} V${String(version).padStart(3, "0")} 提示词已复制。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "复制失败");
    } finally {
      setBusy(null);
    }
  }

  async function copyMaterialFiles(shotId: string, version: number, label?: string) {
    if (copyingMaterialKey) return;
    const copyKey = `${shotId}:${label ?? "all"}`;
    const scrollTop = document.scrollingElement?.scrollTop ?? window.scrollY;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCopyingMaterialKey(copyKey);
    setClipboardFeedback(null);
    try {
      const result = await api.copyUpdreamMaterials(project.id, shotId, version, label);
      setClipboardFeedback({ message: `${shotId} 的 ${result.count} 个素材文件已复制，可直接粘贴上传。`, error: false });
    } catch (reason) {
      setClipboardFeedback({ message: reason instanceof Error ? reason.message : "素材文件复制失败", error: true });
    } finally {
      setCopyingMaterialKey(null);
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: scrollTop, behavior: "auto" });
        if (focusedElement && document.contains(focusedElement)) focusedElement.focus({ preventScroll: true });
      });
    }
  }

  async function scanInbox() {
    setBusy("scan");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { result, refreshError } = await runMutationWithRefresh({
        mutate: () => api.scanGenerationInbox(project.id),
        onSuccess: (scanResult) => onProjectUpdate(scanResult.project),
        refresh: async () => { await load(); },
      });
      const detail = [`导入 ${result.imported.length} 个`, `跳过 ${result.skipped.length} 个`, `错误 ${result.errors.length} 个`].join(" · ");
      const skippedDetails = result.skipped.slice(0, 5).map((item) => `${item.fileName}：${item.reason}`).join("；");
      setNotice(`收件箱扫描完成：${detail}${skippedDetails ? `。跳过原因：${skippedDetails}` : ""}`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "生成中心"));
      if (result.errors.length) onError(result.errors.map((item) => `${item.fileName}：${item.reason}`).join("；"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "扫描失败");
    } finally {
      setBusy(null);
    }
  }

  if (loadError && (!center || !qualityCenter)) return <WorkspaceLoadFailure message={loadError} retrying={loading} onRetry={() => void reload()} onBack={onBack} />;
  if (loading || !center || !qualityCenter) return <div className="empty-state"><div className="loader" /><p>正在读取 H3、Updream 与本地媒体工具状态…</p></div>;
  const generationReady = hasReachedProjectStage(project.currentStage, "STORYBOARD_APPROVED");
  const assetsLocked = hasReachedProjectStage(project.currentStage, "ASSETS_LOCKED");
  const shotCompilationStarted = hasReachedProjectStage(project.currentStage, "GENERATING");
  const shotCompilationCompleted = hasReachedProjectStage(project.currentStage, "GENERATION_REVIEW");
  const uploadedAssets = center.assets.filter((asset) => asset.uploadState.updream === "uploaded").length;
  const packageCount = center.shots.reduce((total, item) => total + item.packages.length, 0);
  const packagedShotCount = center.shots.filter((item) => item.packages.some((packageSummary) => !packageSummary.isStale)).length;
  const allShotPackagesReady = center.shots.length > 0 && packagedShotCount === center.shots.length;
  const { eligibleIds: eligiblePackageIds, blockedIds: blockedPackageIds } = packageCandidates(center.shots);
  const preparationSteps = generationPreparationPlan(project.currentStage, Boolean(center.bootstrap));
  const activeShotCompilation = batchProgress?.shotId ?? compilingShotId;
  const operationBusy = Boolean(busy) || Boolean(compilingShotId);
  const legacyShotIds = legacyPhysicalShotIds(center.shots);
  const durationPolicyShots = center.shots
    .map(({ shot }) => shot)
    .filter((shot) => !isH3ProductDurationCompatible(shot.durationSec, center.capabilities.durationMinSec, center.capabilities.durationMaxSec)
      || !Number.isInteger(shot.startTimeSec)
      || !Number.isInteger(shot.endTimeSec));
  const modelExecutionBlockedShots = center.shots
    .filter(({ preflight }) => preflight.errors.some((error) => error.includes("AI 模型可执行性检查")))
    .map(({ shot }) => shot);
  const inboxFileExample = center.shots.map(({ shot }) => `${shot.id}_V01.mp4`).join("、") || "S001_V01.mp4";
  const shotPackagePanel = (
    <article id="h3-shot-packages" className="generation-panel shot-package-panel generation-primary-task">
      <header><div><span>STEP 03 · H3 SHOT PACKAGES</span><strong>当前操作：逐镜头生成提示词与投递包</strong></div><small>每个镜头独立从 V001 计数；S001 V001 与 S002 V001 是两份不同文件</small></header>
      {!center.shots.length ? <p className="empty-copy">尚无已批准 ShotSpec。</p> : center.shots.map(({ shot, preflight, packages }) => {
        const latestHistorical = packages[0] ?? null;
        const latest = packages.find((packageSummary) => !packageSummary.isStale) ?? null;
        const staleLatest = latest ? null : latestHistorical;
        const materialSelections = latest
          ? latest.requiredAssets.flatMap((asset) => asset.labels.map((label, index) => ({
            label,
            assetId: asset.assetId,
            assetName: asset.name,
            kind: asset.kinds[index],
            role: asset.roles[index],
            filePath: asset.bootstrapFiles[index],
          })))
          : preflight.references.map((reference) => ({
            label: reference.label,
            assetId: reference.assetId,
            assetName: center.assets.find((asset) => asset.id === reference.assetId)?.name ?? reference.assetId,
            kind: reference.kind,
            role: reference.role,
            filePath: reference.filePath,
          }));
        const logicalOnlyAssets = latest?.requiredAssets.filter((asset) => !asset.labels.length) ?? [];
        const isCompilingThisShot = activeShotCompilation === shot.id;
        const generationUnavailable = !(["READY_FOR_GENERATION", "GENERATING"] as ProjectStage[]).includes(project.currentStage) || !preflight.passed || Boolean(busy) || (Boolean(compilingShotId) && !isCompilingThisShot);
        const compactPromptTarget = h3PromptTargetCharacters(shot.durationSec, preflight.references.length);
        const promptStatus = latest?.promptCharacterCount && latest.promptCharacterCount > H3_PROMPT_PLATFORM_MAX_CHARACTERS
          ? "over-limit"
          : latest?.promptCharacterCount && latest.promptCharacterCount > compactPromptTarget ? "needs-compaction" : "";
        return <section className={`generation-shot ${preflight.passed ? "ready" : "blocked"} ${!shot.physicalPlan ? "legacy" : ""} ${activeShotCompilation === shot.id ? "compiling" : ""}`} key={shot.id}>
          <div className="generation-shot-head"><div><code>{shot.id}</code><strong>{shot.purpose}</strong><small>{shot.durationSec}s · {preflight.mode} · {preflight.references.length} 个本地引用</small></div><b>{activeShotCompilation === shot.id ? "COMPILING" : shotPreflightLabel(shot, preflight.passed)}</b></div>
          {staleLatest && <div className="rejection-lock" role="alert"><strong>旧投递包已失效，不能继续复制或投递</strong><p>当前导演脚本是 {shot.durationSec} 秒；历史 V{String(staleLatest.version).padStart(3, "0")} {staleLatest.requestedDurationSec == null ? "未记录时长" : `绑定 ${staleLatest.requestedDurationSec} 秒`}。{staleLatest.staleReasons.join("；")}。若下方预检通过，可直接生成新投递包；若 AI 可执行性未通过，先重做导演脚本。</p></div>}
          {preflight.errors.map((error) => <p className="preflight-error" role="alert" key={error}>{error}</p>)}
          {preflight.warnings.slice(0, 2).map((warning) => <p className="preflight-warning" key={warning}>{warning}</p>)}
          <div className="shot-material-map">
            <header><div><strong>本镜头素材选择清单</strong><span>在 Updream 按标签顺序选择；复制后可直接粘贴文件，不是复制路径文字</span></div><button className="secondary" disabled={!latest || !materialSelections.length || operationBusy} aria-disabled={Boolean(copyingMaterialKey)} onClick={() => latest && void copyMaterialFiles(shot.id, latest.version)}>{copyingMaterialKey === `${shot.id}:all` ? "正在复制…" : "复制全部素材文件"}</button></header>
            {!materialSelections.length ? <p className="empty-copy">本镜头没有本地参考文件，只使用文字提示词。</p> : <div className="shot-material-list">{materialSelections.map((material, index) => <div className="shot-material-row" key={`${material.label}:${material.filePath}`}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <code>{material.label}</code>
              <div><strong>{material.assetId} · {material.assetName}</strong><small>{material.kind} · {material.role}</small><span title={material.filePath}>{windowsFileName(material.filePath)}</span></div>
              <button className="secondary" disabled={!latest || operationBusy} aria-disabled={Boolean(copyingMaterialKey)} onClick={() => latest && void copyMaterialFiles(shot.id, latest.version, material.label)}>{copyingMaterialKey === `${shot.id}:${material.label}` ? "正在复制…" : "复制文件"}</button>
            </div>)}</div>}
            {logicalOnlyAssets.length > 0 && <p className="logical-material-note">仅由提示词描述、无需选择文件：{logicalOnlyAssets.map((asset) => `${asset.assetId} ${asset.name}`).join("；")}</p>}
          </div>
          {latest && <div className={`package-prompt-status ${promptStatus}`}><strong>当前 V{String(latest.version).padStart(3, "0")}：{latest.promptLanguage === "zh" ? "中文主体" : latest.promptLanguage === "en" ? "英文主体" : "中英混合"} · {latest.promptCharacterCount} 字符 · 精简目标 ≤ {compactPromptTarget}</strong><span>{promptStatus === "over-limit" ? `当前旧版本超过云端上限 ${H3_PROMPT_PLATFORM_MAX_CHARACTERS}；请生成新版本，旧包会完整保留。` : promptStatus === "needs-compaction" ? "当前旧版本偏长；生成新版本会自动去重并限制参考标签次数。" : "长度和引用密度符合本镜头精简目标。"}</span></div>}
          <label className="package-generation-setting"><span>本次生产清晰度</span><select disabled={operationBusy} value={generationResolutionByShot[shot.id] ?? "platform-default"} onChange={(event) => setGenerationResolutionByShot((current) => ({ ...current, [shot.id]: event.target.value as GenerationResolution }))}>{generationResolutionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>只写入投递清单，不进入 H3 提示词；最终在 Updream 生产页选择。</small></label>
          {isCompilingThisShot && <div className="generation-compiling shot-inline-compiling" role="status" aria-live="polite"><div className="loader mini" /><div><strong>正在生成 {shot.id} 新版本{batchProgress ? ` · ${batchProgress.index}/${batchProgress.total}` : ""}</strong><p>{batchProgress ? "完成后会自动继续下一个缺失镜头。" : "保持当前浏览位置；完成后只更新本镜头版本。"}</p></div></div>}
          <div className="package-actions"><button className="primary" data-shot-generate={shot.id} disabled={generationUnavailable} aria-disabled={isCompilingThisShot} onClick={() => void createShotPackage(shot.id)}>{isCompilingThisShot ? `正在生成 ${shot.id}…` : latest ? `生成 ${shot.id} 新版本` : staleLatest ? `重建 ${shot.id} 当前版本投递包` : `生成 ${shot.id} H3 投递包`}</button>{latest && <><button className="secondary" disabled={operationBusy} onClick={() => void copyPrompt(shot.id, latest.version)}>复制 {shot.id} V{String(latest.version).padStart(3, "0")} 提示词</button><button className={latest.uploadState === "uploaded" ? "package-uploaded" : "secondary"} disabled={operationBusy} onClick={() => void run(`package:${shot.id}`, () => api.setPackageUploadState(project.id, shot.id, latest.version, latest.uploadState === "uploaded" ? "not-uploaded" : "uploaded"), `${shot.id} V${String(latest.version).padStart(3, "0")} 投递状态已更新。`)}>{latest.uploadState === "uploaded" ? `✓ ${shot.id} 已人工投递` : `标记 ${shot.id} 已投递`}</button></>}</div>
          {latest && <code className="package-path" title={latest.path}>{shot.id} · V{String(latest.version).padStart(3, "0")} · {latest.generationResolution} · {latest.path}</code>}
        </section>;
      })}
    </article>
  );
  return (
    <section className="generation-center-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="generation-head">
        <div><span className="eyebrow">MANUAL PROVIDER HANDOFF</span><h1>{project.title} · 生成中心</h1><p>本地 Codex 文字模型依据官方 MiniMax H3 Skill 编写提示词；Skill 本身不生成内容，Updream 只创建本地人工投递包。</p></div>
        <div className="generation-metrics"><strong>{uploadedAssets}/{center.assets.length}</strong><span>素材已标记上传</span><strong>{packageCount}</strong><span>镜头包版本</span></div>
      </div>
      {notice && <div className="success-notice" role="status" aria-live="polite">✓ {notice}</div>}
      <RefreshWarning message={refreshWarning} />
      {legacyShotIds.length > 0 && <div className="legacy-script-migration" role="status">
        <div><span>旧版导演脚本</span><strong>{legacyShotIds.join("、")} 未启用物理关系硬校验</strong><p>可继续使用现有投递包；若要解决手机朝向、镜面关系和事件时序问题，请用新规则重做导演脚本。系统会返回导演脚本审核，旧导演脚本、分镜和 H3 包仍保留为历史版本。</p></div>
        <button className="primary" disabled={operationBusy} onClick={() => void rebuildShootingScriptWithPhysicalPlan()}>{busy === "rebuild-shooting-script" ? "正在重做导演脚本…" : "使用新规则重做导演脚本 →"}</button>
      </div>}
      {durationPolicyShots.length > 0 && <div className="legacy-script-migration" role="alert">
        <div><span>时长规则不兼容</span><strong>{durationPolicyShots.map((shot) => `${shot.id} ${shot.durationSec}s`).join("、")} 不能用于当前生产</strong><p>镜头必须是 {h3ProductDurationMin(center.capabilities.durationMinSec)}–{Math.floor(center.capabilities.durationMaxSec)} 的整数秒，禁止 7.5 这类小数。旧导演脚本与旧 H3 包会作为历史保留；点击后会返回导演脚本审核并生成符合新规则的版本。</p></div>
        <button className="primary" disabled={operationBusy} onClick={() => void rebuildShootingScriptWithPhysicalPlan()}>{busy === "rebuild-shooting-script" ? "正在重做导演脚本…" : "按整数秒规则重做 →"}</button>
      </div>}
      {modelExecutionBlockedShots.length > 0 && <div className="legacy-script-migration" role="alert">
        <div><span>AI 模型执行复杂度超载</span><strong>{modelExecutionBlockedShots.map((shot) => shot.id).join("、")} 已在进入 H3 前被拦截</strong><p>当前镜头包含过多精确时刻、运镜阶段或高风险任务。系统不会再生成一版满屏红色的提示词；请按新规则重做导演脚本，在真实揭示转折处拆镜并保留边界状态。</p>{narrativeReadiness?.status === "blocked" && <p><b>上游剧情容量也未通过：</b>预计 {narrativeReadiness.estimatedMajorBeats} 个主要 Beat，至少需要 {narrativeReadiness.recommendedMinimumShots} 镜 / {narrativeReadiness.minimumReliableDurationSec} 秒；当前 {project.targetDurationSec} 秒最多容纳 {narrativeReadiness.maximumProductShots} 镜。直接重做导演脚本仍会失败，必须先选择延长时长或删减剧情。</p>}</div>
        {narrativeReadiness?.status === "blocked"
          ? <div className="generation-block-actions"><button className="primary" disabled={operationBusy} onClick={() => void restartNarrativeForReliability(narrativeReadiness.minimumReliableDurationSec)}>{busy === "restart-narrative" ? "正在重置工作流…" : `调整为 ${narrativeReadiness.minimumReliableDurationSec} 秒并重做 →`}</button><button className="secondary" disabled={operationBusy} onClick={() => void restartNarrativeForReliability(project.targetDurationSec)}>{busy === "restart-narrative" ? "正在重置工作流…" : `保持 ${project.targetDurationSec} 秒，删减剧情重做`}</button></div>
          : <button className="primary" disabled={operationBusy} onClick={() => void rebuildShootingScriptWithPhysicalPlan()}>{busy === "rebuild-shooting-script" ? "正在重做导演脚本…" : "按模型可执行性重做 →"}</button>}
      </div>}
      {!generationReady && <div className="generation-lock"><b>当前尚未到达生成阶段</b><p>先完成并批准资产定义、ShotSpec 与分镜。生成中心可以查看能力，但不会越过审批门禁。</p></div>}
      <div className="provider-capability-card">
        <div><span>H3 CAPABILITY / VERIFIED {new Date(center.capabilities.verifiedAt).toLocaleDateString("zh-CN")}</span><strong>{center.capabilities.model}</strong><p>平台能力 {center.capabilities.durationMinSec}–{center.capabilities.durationMaxSec} 秒 · 产品生产规则 {h3ProductDurationMin(center.capabilities.durationMinSec)}–{Math.floor(center.capabilities.durationMaxSec)} 整数秒 · {center.capabilities.aspectRatios.join(" / ")} · 资料默认短边 {center.capabilities.defaultShortSide}px（非最低限制）</p></div>
        <div className="provider-skills">{center.skills.map((skill) => <code key={skill.name}>{skill.name}<small>{skill.version} · {skill.sha256.slice(0, 10)}…</small></code>)}</div>
      </div>
      <div className="handoff-step-grid">
        <article className={project.currentStage === "STORYBOARD_APPROVED" ? "active" : center.bootstrap || assetsLocked ? "done" : ""}><span>01</span><div><strong>锁定批准素材</strong><p>冻结当前资产与 ShotSpec 投递基线。</p></div><button className="secondary" disabled={project.currentStage !== "STORYBOARD_APPROVED" || Boolean(busy)} onClick={() => void run("lock", () => api.lockAssets(project.id), "素材已锁定；现在可以建立 Updream 初始化包。")}>{busy === "lock" ? "锁定中…" : project.currentStage === "STORYBOARD_APPROVED" ? "确认锁定" : center.bootstrap || assetsLocked ? "已完成" : "等待分镜批准"}</button></article>
        <article className={project.currentStage === "ASSETS_LOCKED" ? "active" : center.bootstrap ? "done" : ""}><span>02</span><div><strong>创建初始化包</strong><p>汇总素材索引和人工上传清单。</p></div><button className="secondary" disabled={project.currentStage !== "ASSETS_LOCKED" || Boolean(busy)} onClick={() => void run("bootstrap", () => api.createUpdreamBootstrap(project.id), "Updream 初始化包已创建；镜头提示词可以开始编译。")}>{busy === "bootstrap" ? "创建中…" : center.bootstrap ? "已创建" : project.currentStage === "ASSETS_LOCKED" ? "创建本地包" : "等待素材锁定"}</button></article>
        <article className={project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING" ? "active" : shotCompilationCompleted ? "done" : ""}><span>03</span><div><strong>逐镜头编译</strong><p>每次都新增版本，不覆盖旧包。</p></div><b>{project.currentStage === "READY_FOR_GENERATION" ? "READY" : project.currentStage === "GENERATING" ? "ACTIVE" : shotCompilationCompleted ? "已完成" : shotCompilationStarted ? "ACTIVE" : "WAIT"}</b></article>
      </div>
      <div className={`generation-next-action ${allShotPackagesReady ? "handoff-ready" : ""}`}>
        <div><span>SAFE AUTO FLOW</span><strong>{preparationSteps.length ? "一键完成素材锁定与初始化" : allShotPackagesReady ? `全部 ${packagedShotCount} 个镜头包已就绪；现在前往 Updream` : eligiblePackageIds.length ? `一键补齐 ${eligiblePackageIds.join("、")} 的 H3 投递包` : `有 ${blockedPackageIds.length} 个镜头需要处理预检问题`}</strong><p>{preparationSteps.length ? "只执行本地确定性步骤，已完成步骤不会重复。" : allShotPackagesReady ? "复制提示词到云端生成视频；外部平台不会被程序擅自操作。" : `已有镜头包不会重复生成${blockedPackageIds.length ? `；${blockedPackageIds.join("、")} 会安全跳过` : ""}。`}</p></div>
        {preparationSteps.length ? <button className="primary" disabled={Boolean(busy)} onClick={() => void prepareGeneration()}>{busy === "prepare" ? "正在自动准备…" : "一键准备生成 →"}</button> : allShotPackagesReady ? <a className="primary" href="#h3-shot-packages">查看并复制提示词 ↓</a> : <button className="primary" disabled={!eligiblePackageIds.length || !(project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING") || Boolean(busy)} onClick={() => void createMissingShotPackages()}>{busy === "batch-shots" ? `正在生成 ${batchProgress?.index ?? 0}/${batchProgress?.total ?? eligiblePackageIds.length}…` : `一键生成 ${eligiblePackageIds.length} 个缺失镜头包 →`}</button>}
      </div>
      {shotPackagePanel}
      <article className={`generation-import-card ${qualityCenter.mediaTools.ffprobeAvailable ? "ready" : "blocked"}`}>
        <div>
          <span>LOCAL GENERATION INBOX</span>
          <strong>生成视频收件箱</strong>
          <p>Updream 生成完成后，把文件命名为 {inboxFileExample} 并放入下方目录。系统复制归档，绝不覆盖原件。</p>
          <code>{qualityCenter.inboxPath}</code>
        </div>
        <div className="import-tool-state">
          <b>{qualityCenter.mediaTools.ffprobeAvailable ? "FFPROBE READY" : "FFPROBE MISSING"}</b>
          <small>{qualityCenter.generations.length} 个已导入版本</small>
          <button className="primary" disabled={!allShotPackagesReady || !(["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage) || !qualityCenter.mediaTools.ffprobeAvailable || Boolean(busy)} onClick={() => void scanInbox()}>{busy === "scan" ? "正在校验…" : !allShotPackagesReady ? "先补齐全部镜头包" : "视频下载后再扫描"}</button>
        </div>
      </article>
      <article className={`media-preflight-card ${qualityCenter.mediaTools.roughCutReady ? "ready" : "blocked"}`}>
        <header><div><span>MEDIA PREFLIGHT</span><strong>{qualityCenter.mediaTools.roughCutReady ? "粗剪工具链已就绪" : "粗剪工具链未就绪"}</strong></div><b>{qualityCenter.mediaTools.roughCutReady ? "READY" : `缺少 ${missingRoughCutCapabilities(qualityCenter.mediaTools).join(" / ")}`}</b></header>
        <div className="media-capability-grid">
          <span className={qualityCenter.mediaTools.ffmpegAvailable ? "ok" : "missing"}>FFmpeg</span>
          <span className={qualityCenter.mediaTools.ffprobeAvailable ? "ok" : "missing"}>ffprobe</span>
          <span className={qualityCenter.mediaTools.libx264Available ? "ok" : "missing"}>libx264</span>
          <span className={qualityCenter.mediaTools.aacAvailable ? "ok" : "missing"}>AAC</span>
        </div>
        <p>环境变量优先；否则自动发现项目便携目录。程序只报告真实探测结果，不会自动安装或伪造可用状态。</p>
        <div className="media-setup-path"><code>{qualityCenter.mediaTools.setupDirectory}</code><button className="secondary" onClick={() => void navigator.clipboard.writeText(qualityCenter.mediaTools.setupDirectory)}>复制便携目录</button></div>
      </article>
      {!qualityCenter.mediaTools.ffprobeAvailable && <div className="generation-lock"><b>当前机器未检测到 ffprobe</b><p>导入按钮已真实拦截。可把 ffmpeg 与 ffprobe 放入上方便携目录，或配置 AI_VIDEO_STUDIO_FFPROBE_PATH 后重启；系统不会把未验证文件标成成功。</p></div>}
      {qualityCenter.generations.length > 0 && <div className="generation-version-strip">{qualityCenter.generations.map((generation) => <span key={generation.id}><code>{generation.shotId} V{String(generation.generationVersion).padStart(3, "0")}</code><b>{generation.status}</b><small>{generation.media.width}×{generation.media.height} · {generation.media.durationSec.toFixed(2)}s</small></span>)}</div>}
      <div className="generation-columns asset-registration-columns">
        <article className="generation-panel asset-upload-panel">
          <header><div><span>UPDREAM ASSETS</span><strong>素材上传登记</strong></div><small>只记录你的人工操作</small></header>
          {!center.assets.length ? <p className="empty-copy">尚无资产。</p> : center.assets.map((asset) => {
            const uploaded = asset.uploadState.updream === "uploaded";
            return <div className="upload-row" key={asset.id}><div><code>{asset.id}</code><strong>{asset.name}</strong><small>{asset.localFiles.length ? `${asset.localFiles.length} 个本地文件` : "仅逻辑定义"}</small></div><button className={uploaded ? "uploaded" : ""} disabled={!center.bootstrap || Boolean(busy)} onClick={() => void run(`asset:${asset.id}`, () => api.setAssetUploadState(project.id, asset.id, uploaded ? "not-uploaded" : "uploaded"), `${asset.id} 已标记为${uploaded ? "未上传" : "已上传"}。`)}>{uploaded ? "✓ 已上传" : "标记已上传"}</button></div>;
          })}
          {center.bootstrap && <button className="path-copy secondary" onClick={() => void navigator.clipboard.writeText(center.bootstrap?.path ?? "")}>复制初始化包路径</button>}
        </article>
      </div>
      {clipboardFeedback && <div className={`floating-operation-toast ${clipboardFeedback.error ? "error" : "success"}`} role="status" aria-live="polite">{clipboardFeedback.error ? "!" : "✓"} {clipboardFeedback.message}</div>}
      {generationFeedback && <div className={`floating-operation-toast ${generationFeedback.error ? "error" : "success"}`} role="status" aria-live="polite">{generationFeedback.error ? "!" : "✓"} {generationFeedback.message}</div>}
    </section>
  );
}

const reviewDimensionLabels: Record<(typeof reviewDimensions)[number], string> = {
  identity: "人物身份",
  "costume-props": "服装与道具",
  scene: "场景一致性",
  action: "动作完成度",
  camera: "镜头运动",
  "composition-direction": "构图与方向",
  "start-end-state": "起止状态",
  "picture-quality": "画面质量",
  "sound-quality": "声音质量",
};

const qualityDecisionLabels: Record<QualityDecision, string> = {
  accepted: "通过",
  "conditional-pass": "有条件通过（不放行）",
  "retry-same-model": "同模型重试",
  "revise-prompt-retry": "修改提示词后重试",
  "switch-model": "更换模型",
  "manual-fix": "人工修复 / 暂不决策",
};

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function QualityReviewWorkspace({ project, refreshRevision, onBack, onProjectUpdate, onError }: {
  project: Project;
  refreshRevision: number;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const [center, setCenter] = useState<QualityCenter | null>(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [form, setForm] = useState<QualityReviewInput>(() => createEmptyQualityReview());
  const [conditionsText, setConditionsText] = useState("");
  const [retryText, setRetryText] = useState("");
  const [unverifiedText, setUnverifiedText] = useState("");
  const [quickIssueIds, setQuickIssueIds] = useState<QuickReviewIssueId[]>([]);
  const [quickNote, setQuickNote] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const loadEpoch = useRequestEpoch();

  async function load(): Promise<boolean> {
    const epoch = ++loadEpoch.current;
    try {
      const result = await api.qualityCenter(project.id);
      if (epoch !== loadEpoch.current) return false;
      setCenter(result);
      setSelectedJobId((current) => result.generations.some((item) => item.id === current)
        ? current
        : result.generations.find((item) => item.status === "review")?.id ?? result.generations[0]?.id ?? "");
      return true;
    } catch (reason) {
      if (epoch !== loadEpoch.current) return false;
      throw reason;
    }
  }

  async function reload() {
    setLoading(true);
    setLoadError(null);
    onError(null);
    try {
      const applied = await load();
      if (applied) setLoading(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "质检中心读取失败";
      setLoadError(message);
      onError(message);
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [project.id, project.updatedAt, refreshRevision]);

  const generation = center?.generations.find((item) => item.id === selectedJobId) ?? null;
  const shot = center?.shots.find((item) => item.id === generation?.shotId) ?? null;
  const reviewHistory = center?.reviews.filter((item) => item.jobId === selectedJobId) ?? [];
  function generationGateLabel(item: ImportedGeneration): string {
    const latestReview = center?.reviews.find((review) => review.jobId === item.id);
    if (!latestReview) return item.status === "review" ? "待人工审核" : item.status;
    if (latestReview.decision === "conditional-pass") return "有条件通过（未放行）";
    if (latestReview.decision === "accepted") {
      const fullyAccepted = latestReview.dimensions.every((dimension) => dimension.status === "pass")
        && latestReview.conditions.length === 0
        && latestReview.unverifiedClaims.length === 0
        && item.status === "accepted";
      return fullyAccepted ? "正式通过" : "审核记录异常";
    }
    return qualityDecisionLabels[latestReview.decision];
  }
  const acceptedShotCount = center?.gateAudit.acceptedShotIds.length ?? 0;
  const canRender = center?.gateAudit.passed ?? false;
  const mediaMissing = center ? missingRoughCutCapabilities(center.mediaTools) : [];

  function updateDimension(index: number, field: "status" | "note" | "evidence", value: string) {
    setForm((current) => ({
      ...current,
      dimensions: current.dimensions.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item),
    }));
  }

  function resetReviewForms() {
    setForm(createEmptyQualityReview());
    setConditionsText("");
    setRetryText("");
    setUnverifiedText("");
    setQuickIssueIds([]);
    setQuickNote("");
  }

  function toggleQuickIssue(issueId: QuickReviewIssueId) {
    setQuickIssueIds((current) => current.includes(issueId)
      ? current.filter((item) => item !== issueId)
      : [...current, issueId]);
  }

  async function submitReview(inputOverride?: QualityReviewInput, successMessage?: string) {
    if (!generation || !center) return;
    setBusy("review");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const input: QualityReviewInput = inputOverride ?? {
          ...form,
          conditions: splitLines(conditionsText),
          retryInstructions: splitLines(retryText),
          unverifiedClaims: splitLines(unverifiedText),
        };
      const reviewResult = await api.reviewGeneration(project.id, generation.id, input);
      onProjectUpdate(reviewResult.project);
      resetReviewForms();
      setNotice(successMessage ?? `${generation.shotId} V${String(generation.generationVersion).padStart(3, "0")} 的质检记录已保存，原记录未被覆盖。粗剪需要单独明确创建。`);
      try {
        await load();
      } catch (reason) {
        setRefreshWarning(formatRefreshWarning(reason instanceof Error ? reason : new Error("刷新失败"), "质检中心"));
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "质检提交失败");
    } finally {
      setBusy(null);
    }
  }

  async function renderRoughCut() {
    setBusy("render");
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { result, refreshError } = await runMutationWithRefresh({
        mutate: () => api.renderRoughCut(project.id),
        onSuccess: (renderResult) => onProjectUpdate(renderResult.project),
        refresh: async () => { await load(); },
      });
      setNotice(`粗剪 V${String(result.render.version).padStart(3, "0")} 已生成并进入成片终审。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "质检中心"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "粗剪失败");
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !center) return <WorkspaceLoadFailure message={loadError} retrying={loading} onRetry={() => void reload()} onBack={onBack} />;
  if (loading || !center) return <div className="empty-state"><div className="loader" /><p>正在读取生成视频与质检历史…</p></div>;
  return (
    <section className="quality-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="quality-head">
        <div><span className="eyebrow">HUMAN QUALITY GATE</span><h1>{project.title} · 视频审核</h1><p>默认使用快速审核；需要时间码和逐项证据时再展开九维高级审核。</p></div>
        <div className="quality-skill"><span>ACTIVE SKILL</span><strong>{center.skill.name}</strong><code>{center.skill.version} · {center.skill.sha256.slice(0, 12)}…</code></div>
      </div>
      {notice && <div className="success-notice" role="status" aria-live="polite">✓ {notice}</div>}
      <RefreshWarning message={refreshWarning} />
      {!center.gateAudit.passed && <article className="generation-readiness-card blocked" role="alert">
        <strong>当前项目不能进入粗剪或交付</strong>
        <p>阶段名称不再作为放行依据；系统会逐镜头核对提示词投递包、最新生成版本和九维正式通过记录。</p>
        {center.gateAudit.blockers.map((blocker) => <p className="preflight-error" key={blocker}>{blocker}</p>)}
      </article>}
      {!center.generations.length ? (
        <div className="quality-empty"><strong>还没有可审核的生成视频</strong><p>先在生成中心把 S003_V01.mp4 放入收件箱并完成扫描导入。</p><code>{center.inboxPath}</code></div>
      ) : (
        <>
          <div className="quality-toolbar">
            <label><span>生成版本</span><select disabled={Boolean(busy)} value={selectedJobId} onChange={(event) => { setSelectedJobId(event.target.value); resetReviewForms(); }}>
              {center.generations.map((item) => <option key={item.id} value={item.id}>{item.shotId} · V{String(item.generationVersion).padStart(3, "0")} · {generationGateLabel(item)}</option>)}
            </select></label>
            <div><b>{generation ? generationGateLabel(generation) : "未选择"}</b><span>{generation?.media.width}×{generation?.media.height} · {generation?.media.durationSec.toFixed(3)}s · {generation?.media.frameRate.toFixed(2)}fps</span></div>
          </div>
          <div className="quality-columns">
            <article className="quality-target">
              <header><span>APPROVED TARGET</span><strong>{shot?.id} · {shot?.purpose}</strong></header>
              {shot && <dl>
                <div><dt>人物</dt><dd>{shot.characterIds.join("、") || "无"}</dd></div>
                <div><dt>场景</dt><dd>{shot.sceneId}</dd></div>
                <div><dt>动作</dt><dd>{shot.action}</dd></div>
                <div><dt>景别</dt><dd>{shot.shotSize}</dd></div>
                <div><dt>机位 / 运动</dt><dd>{shot.camera.position} / {shot.camera.movement}</dd></div>
                <div><dt>起始状态</dt><dd>{shot.startState}</dd></div>
                <div><dt>结束状态</dt><dd>{shot.endState}</dd></div>
                <div><dt>声音</dt><dd>{shot.sound.join("；") || "未定义"}</dd></div>
              </dl>}
              {reviewHistory.length > 0 && <div className="review-history"><span>历史结论</span>{reviewHistory.map((review) => <p key={review.id}><b>{qualityDecisionLabels[review.decision]}</b><small>{new Date(review.createdAt).toLocaleString("zh-CN")}</small></p>)}</div>}
            </article>
            <article className="quality-player">
              <header><span>ACTUAL VIDEO</span><strong>{generation?.sourceFileName}</strong></header>
              {generation && <video key={generation.id} controls preload="metadata" src={api.generationMediaUrl(project.id, generation.id)} />}
              {generation && generation.reviewFramePaths.length > 0 && <div className="review-frame-grid">
                {generation.reviewFramePaths.map((_framePath, index) => <figure key={`${generation.id}-${index}`}>
                  <img src={api.generationReviewFrameUrl(project.id, generation.id, index)} alt={`${generation.shotId} ${["起始", "中段", "结束"][index] ?? `关键帧 ${index + 1}`}`} loading="lazy" />
                  <figcaption>{["起始状态", "中段动作", "结束状态"][index] ?? `关键帧 ${index + 1}`}</figcaption>
                </figure>)}
              </div>}
              <p>导入哈希：<code>{generation?.sourceHash}</code></p>
            </article>
          </div>
          <article className="quick-review-card">
            <header><div><span>QUICK REVIEW</span><strong>快速审核当前镜头</strong><p>完整播放一次视频：没问题直接通过；有问题只勾选实际缺陷。</p></div><b>{generation?.shotId} · V{String(generation?.generationVersion ?? 0).padStart(3, "0")}</b></header>
            <div className="quick-review-actions">
              <button className="primary quick-pass" disabled={generation?.status !== "review" || Boolean(busy)} onClick={() => void submitReview(createQuickAcceptedReview(), `${generation?.shotId} 已快速通过；其他镜头仍需分别审核。`)}>✓ 通过当前镜头</button>
              <span>或标记问题后仅重做当前镜头</span>
            </div>
            <div className="quick-issue-grid" aria-label="镜头问题类型">
              {quickReviewIssues.map((issue) => <button key={issue.id} type="button" aria-pressed={quickIssueIds.includes(issue.id)} className={quickIssueIds.includes(issue.id) ? "selected" : ""} disabled={generation?.status !== "review" || Boolean(busy)} onClick={() => toggleQuickIssue(issue.id)}>{issue.label}</button>)}
            </div>
            <label className="quick-review-note"><span>补充说明（可选）</span><textarea disabled={generation?.status !== "review" || Boolean(busy)} value={quickNote} onChange={(event) => setQuickNote(event.target.value)} placeholder="例如：3.2 秒右上角出现提示字" /></label>
            <div className="quick-reject-row"><p>{quickIssueIds.length ? `已选择 ${quickIssueIds.length} 项问题；提交后 ${generation?.shotId} 返回生成阶段，旧视频保留。` : "请选择至少一个实际问题。不会影响其他已通过镜头。"}</p><button className="secondary danger" disabled={generation?.status !== "review" || !quickIssueIds.length || Boolean(busy)} onClick={() => void submitReview(createQuickRejectedReview(quickIssueIds, quickNote), `${generation?.shotId} 已驳回并保存修复要求；请只重新生成该镜头的新版本。`)}>驳回当前镜头并生成重试要求</button></div>
          </article>
          <article className={`quality-next-step ${canRender ? "ready" : "waiting"}`}>
            <div><span>NEXT STEP</span><strong>{canRender ? `全部 ${center.shots.length} 个镜头审核通过` : `已通过 ${acceptedShotCount} / ${center.shots.length} 个镜头`}</strong><p>{canRender ? "下一步将按镜头顺序合并视频并创建新的本地粗剪版本；原视频不会被覆盖。" : "继续从上方切换到尚未通过的镜头完成审核。"}</p></div>
            {canRender && <button className="primary" disabled={!center.mediaTools.roughCutReady || Boolean(busy) || !(project.currentStage === "GENERATION_REVIEW" || project.currentStage === "EDITING")} onClick={() => void renderRoughCut()}>{busy === "render" ? "FFmpeg 正在生成粗剪…" : "创建粗剪并进入成片终审 →"}</button>}
            {canRender && !center.mediaTools.roughCutReady && <p className="tool-block">媒体预检缺少 {mediaMissing.join("、") || "必要能力"}，暂时不能创建粗剪。</p>}
          </article>
          <article className="quality-form-card">
            <header><div><span>ADVANCED REVIEW</span><strong>九维详细审核</strong></div><button className="secondary advanced-review-toggle" type="button" onClick={() => setAdvancedOpen((current) => !current)}>{advancedOpen ? "收起高级审核" : "展开高级审核"}</button></header>
            {!advancedOpen ? <p className="advanced-review-help">仅在需要逐项记录时间码、证据或有条件通过时使用；“有条件通过”只保存待处理条件，不会计入通过，也不会触发粗剪。</p> : <><div className="dimension-grid">
              {form.dimensions.map((item, index) => <div className={`dimension-row ${item.status}`} key={item.dimension}>
                <strong>{String(index + 1).padStart(2, "0")} · {reviewDimensionLabels[item.dimension]}</strong>
                <select disabled={Boolean(busy)} value={item.status} onChange={(event) => updateDimension(index, "status", event.target.value)}>
                  <option value="not-reviewed">未审核</option><option value="pass">通过</option><option value="warning">警告</option><option value="fail">失败</option>
                </select>
                <input disabled={Boolean(busy)} value={item.note} onChange={(event) => updateDimension(index, "note", event.target.value)} placeholder="判断说明" />
                <input disabled={Boolean(busy)} value={item.evidence} onChange={(event) => updateDimension(index, "evidence", event.target.value)} placeholder="时间码 / 可见证据" />
              </div>)}
            </div>
            <div className="quality-decision-grid">
              <label><span>总决策</span><select disabled={Boolean(busy)} value={form.decision} onChange={(event) => setForm((current) => ({ ...current, decision: event.target.value as QualityDecision }))}>{Object.entries(qualityDecisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="wide"><span>审核摘要</span><textarea disabled={Boolean(busy)} value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} /></label>
              <label><span>通过条件（每行一条）</span><textarea disabled={Boolean(busy)} value={conditionsText} onChange={(event) => setConditionsText(event.target.value)} /></label>
              <label><span>重试说明（每行一条）</span><textarea disabled={Boolean(busy)} value={retryText} onChange={(event) => setRetryText(event.target.value)} /></label>
              <label className="wide"><span>未验证声明（每行一条）</span><textarea disabled={Boolean(busy)} value={unverifiedText} onChange={(event) => setUnverifiedText(event.target.value)} /></label>
            </div>
            <div className="quality-actions">
              <button className="primary" disabled={generation?.status !== "review" || Boolean(busy)} onClick={() => void submitReview()}>{busy === "review" ? "正在保存不可变记录…" : generation?.status === "review" ? "保存九维质检结论" : "该版本已完成质检"}</button>
            </div>
            </>}
          </article>
        </>
      )}
    </section>
  );
}

function DeliveryWorkspace({ project, refreshRevision, onBack, onProjectUpdate, onDelivered, onError }: {
  project: Project;
  refreshRevision: number;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onDelivered: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const [center, setCenter] = useState<QualityCenter | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const loadEpoch = useRequestEpoch();

  async function load(): Promise<boolean> {
    const epoch = ++loadEpoch.current;
    try {
      const result = await api.qualityCenter(project.id);
      if (epoch !== loadEpoch.current) return false;
      setCenter(result);
      setSelectedRenderId((current) => result.renders.some((item) => item.id === current)
        ? current
        : result.renders[0]?.id ?? "");
      return true;
    } catch (reason) {
      if (epoch !== loadEpoch.current) return false;
      throw reason;
    }
  }

  async function reload() {
    setLoading(true);
    setLoadError(null);
    onError(null);
    try {
      const applied = await load();
      if (applied) setLoading(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "交付中心读取失败";
      setLoadError(message);
      onError(message);
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [project.id, project.updatedAt, refreshRevision]);

  const render = center?.renders.find((item) => item.id === selectedRenderId) ?? null;

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { result, refreshError } = await runMutationWithRefresh({
        mutate: () => api.decideRender(project.id, selectedRenderId, decision, comment),
        onSuccess: (result) => onProjectUpdate(result.project),
        refresh: async () => { await load(); },
      });
      if (decision === "approved") {
        onDelivered(result.project);
        return;
      }
      setNotice("终审已驳回，项目已返回剪辑阶段，旧粗剪仍完整保留。");
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "交付中心"));
      setComment("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "终审失败");
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !center) return <WorkspaceLoadFailure message={loadError} retrying={loading} onRetry={() => void reload()} onBack={onBack} />;
  if (loading || !center) return <div className="empty-state"><div className="loader" /><p>正在读取粗剪和交付历史…</p></div>;
  return (
    <section className="delivery-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="quality-head">
        <div><span className="eyebrow">FINAL REVIEW & DELIVERY</span><h1>{project.title} · 成片交付</h1><p>每次粗剪与交付均创建新版本；批准、驳回和文件哈希永久留档。</p></div>
        <div className="quality-skill"><span>PROJECT STATE</span><strong>{stageLabels[project.currentStage]}</strong><code>{center.renders.length} 个粗剪版本</code></div>
      </div>
      {notice && <div className="success-notice" role="status" aria-live="polite">✓ {notice}</div>}
      <RefreshWarning message={refreshWarning} />
      {!center.gateAudit.passed && <article className="generation-readiness-card blocked" role="alert">
        <strong>这条粗剪 / 交付记录的上游证据不完整</strong>
        <p>现有文件与历史不会被删除，但在提示词和正式审核全部闭环前，系统不会再批准新的交付版本。</p>
        {center.gateAudit.blockers.map((blocker) => <p className="preflight-error" key={blocker}>{blocker}</p>)}
      </article>}
      {!center.renders.length ? (
        <div className="quality-empty"><strong>尚未创建粗剪</strong><p>全部镜头通过九维审核后，在“质量审核”中创建第一个本地粗剪版本。</p></div>
      ) : (
        <div className="delivery-layout">
          <article className="render-list">
            <header><span>VERSION HISTORY</span><strong>粗剪版本</strong></header>
            {center.renders.map((item) => <button className={item.id === selectedRenderId ? "active" : ""} key={item.id} disabled={busy} onClick={() => setSelectedRenderId(item.id)}><code>V{String(item.version).padStart(3, "0")}</code><span>{item.status}</span><small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small></button>)}
          </article>
          <article className="delivery-player">
            <header><span>RENDER PREVIEW</span><strong>{render ? `粗剪 V${String(render.version).padStart(3, "0")}` : "未选择"}</strong></header>
            {render && render.status !== "failed" && <video key={render.id} controls preload="metadata" src={api.renderMediaUrl(project.id, render.id)} />}
            {render?.error && <p className="preflight-error" role="alert">{render.error}</p>}
            {render && <dl>
              <div><dt>粗剪</dt><dd>{render.videoPath}</dd></div>
              <div><dt>字幕</dt><dd>{render.subtitlePath ?? "无"}</dd></div>
              <div><dt>报告</dt><dd>{render.reportPath}</dd></div>
              <div><dt>交付文件</dt><dd>{render.deliveryVideoPath ?? "尚未批准"}</dd></div>
            </dl>}
            {render && render.status !== "failed" && <div className="delivery-downloads">
              <a className="secondary" href={api.renderFileUrl(project.id, render.id, "video")} download>下载 MP4</a>
              {render.subtitlePath && <a className="secondary" href={api.renderFileUrl(project.id, render.id, "subtitle")} download>下载 SRT</a>}
              <a className="secondary" href={api.renderFileUrl(project.id, render.id, "report")} download>下载报告</a>
            </div>}
          </article>
          <article className="delivery-decision">
            <header><span>HUMAN GATE</span><strong>成片终审</strong></header>
            <p>批准会复制到独立交付目录；驳回会返回剪辑阶段，不删除当前版本。</p>
            <label><span>终审意见</span><textarea disabled={busy} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="驳回时必填；批准时可选" /></label>
            <div><button className="secondary danger" disabled={project.currentStage !== "FINAL_REVIEW" || render?.status !== "review" || busy} onClick={() => void decide("rejected")}>驳回并返回剪辑</button><button className="primary" disabled={!center.gateAudit.passed || project.currentStage !== "FINAL_REVIEW" || render?.status !== "review" || busy} onClick={() => void decide("approved")}>批准并创建交付版本</button></div>
          </article>
        </div>
      )}
    </section>
  );
}

function AssetLibraryWorkspace({ project, refreshRevision, onBack, onProjectUpdate, onError }: { project: Project; refreshRevision: number; onBack: () => void; onProjectUpdate: (project: Project) => void; onError: (message: string | null) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [designMode, setDesignMode] = useState<AssetDesignMode>("original-proposal");
  const [busy, setBusy] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [assetAuthorizationConfirmed, setAssetAuthorizationConfirmed] = useState(false);
  const regenerateDialogRef = useDialogFocus<HTMLDivElement>(regenerateOpen, () => setRegenerateOpen(false), Boolean(busy));
  const loadEpoch = useRequestEpoch();
  const foregroundRevisionRef = useRef(refreshRevision);
  async function loadAssets(): Promise<boolean> {
    const epoch = ++loadEpoch.current;
    try {
      const result = await api.listAssets(project.id);
      if (epoch !== loadEpoch.current) return false;
      setAssets(result.assets);
      return true;
    } catch (reason) {
      if (epoch !== loadEpoch.current) return false;
      throw reason;
    }
  }
  useEffect(() => {
    const foregroundRefresh = foregroundRevisionRef.current !== refreshRevision;
    foregroundRevisionRef.current = refreshRevision;
    if (!foregroundRefresh) setLoading(true);
    void loadAssets()
      .then((applied) => { if (applied) setLoading(false); })
      .catch((reason: Error) => { onError(reason.message); setLoading(false); });
  }, [project.id, project.updatedAt, refreshRevision]);
  useEffect(() => {
    if (startedAt == null) return;
    const update = () => setElapsed(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  async function regenerate() {
    setRegenerateOpen(false);
    setBusy("regenerate");
    setStartedAt(Date.now());
    setNotice(null);
    setRefreshWarning(null);
    onError(null);
    try {
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.generateArtifact(project.id, "asset-bible", { designMode }),
        onSuccess: (result) => onProjectUpdate(result.project),
        refresh: async () => { await loadAssets(); },
      });
      setNotice("新的资产定义版本已生成；旧人物设定和下游导演脚本已保留为过期历史。请检查设定并上传需要的参考图。");
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "素材库"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "资产设定生成失败");
    } finally {
      setBusy(null);
      setStartedAt(null);
    }
  }

  async function uploadReference(assetId: string, file: File, role: string) {
    loadEpoch.current += 1;
    setBusy(`upload:${assetId}`);
    onError(null);
    try {
      validateReferenceUpload(file);
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      setRefreshWarning(null);
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.uploadAssetReference(project.id, assetId, { fileName: file.name, mimeType: file.type, dataBase64, role, authorizationConfirmed: true }),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => { await loadAssets(); },
      });
      setNotice(`${assetId} 的${role}参考图已保存到项目目录并计算 SHA256。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "素材库"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图上传失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function replaceReference(assetId: string, index: number, file: File) {
    loadEpoch.current += 1;
    setBusy(`replace:${assetId}:${index}`);
    onError(null);
    try {
      validateReferenceUpload(file);
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.replaceAssetReference(project.id, assetId, index, { fileName: file.name, mimeType: file.type, dataBase64, authorizationConfirmed: true }),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => { await loadAssets(); },
      });
      setNotice(`${assetId} 的第 ${index + 1} 张参考图已安全更换；旧图保留在项目历史回收目录。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "素材库"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图更换失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function deleteReference(assetId: string, index: number) {
    loadEpoch.current += 1;
    setBusy(`delete:${assetId}:${index}`);
    onError(null);
    try {
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.deleteAssetReference(project.id, assetId, index),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => { await loadAssets(); },
      });
      setNotice(`${assetId} 的参考图已删除绑定；原文件已移入项目历史回收目录。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "素材库"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图删除失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function generateReferencePrompt(assetId: string, role: AssetReferenceRole) {
    setBusy(`prompt:${assetId}`);
    setNotice(null);
    onError(null);
    try {
      const result = await api.generateAssetReferencePrompt(project.id, assetId, role);
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      setNotice(`${assetId} 的${role}参考图提示词已由本地 Codex 生成并保存。`);
      return { prompt: result.prompt, imageProvider: result.imageProvider };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图提示词生成失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function generateReferenceImage(assetId: string, promptId: string) {
    setBusy(`image:${assetId}`);
    onError(null);
    try {
      const result = await api.generateAssetReferenceImage(project.id, assetId, promptId);
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      setNotice(`${assetId} 的参考图已由图像 Provider 生成、校验并绑定。`);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图生成失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  const approved = assets.filter((asset) => asset.approved).length;
  const incomplete = assets.filter(assetNeedsDesign).length;
  const canUpload = project.currentStage === "ASSET_BIBLE_REVIEW";
  return (
    <section className="asset-library-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="library-head"><div><span className="eyebrow">LOCAL ASSET REGISTRY</span><h1>{project.title} · 素材库</h1><p>人物外观、参考图、版本和镜头引用以本地项目为准。</p></div><div className="library-stats"><strong>{assets.length}</strong><span>总资产</span><strong>{approved}</strong><span>审批记录</span><strong>{incomplete}</strong><span>设计不完整</span></div><button className="primary" disabled={Boolean(busy)} onClick={() => setRegenerateOpen(true)}>{busy === "regenerate" ? "正在生成…" : assets.length ? "重做完整资产设定" : "生成资产设定"}</button></div>
      {busy === "regenerate" && <div className="generation-progress"><div className="loader mini" /><div><strong>资产设计 Skill 正在生成完整视觉方案 · 已等待 {formatElapsed(elapsed)}</strong><p>复杂资产通常 2–8 分钟，本任务最长等待 12 分钟。不会覆盖旧版本，也不会自动批准。</p></div><b>{formatElapsed(elapsed)}</b></div>}
      {notice && <div className="success-notice" role="status" aria-live="polite">✓ {notice}</div>}
      <RefreshWarning message={refreshWarning} />
      {incomplete > 0 && <div className="rejection-lock"><strong>检测到 {incomplete} 个空壳或待补充资产</strong><p>这些资产不能作为稳定人物设定进入后续生成。选择“原创完整设定”重做，或在资产审核阶段上传参考图。</p></div>}
      {loading ? <div className="empty-state"><div className="loader" /><p>正在载入素材主库…</p></div> : <AssetBiblePanel assets={assets} projectId={project.id} editable={canUpload} busy={busy} authorizationConfirmed={assetAuthorizationConfirmed} onAuthorizationChange={setAssetAuthorizationConfirmed} onUpload={uploadReference} onReplace={replaceReference} onDelete={deleteReference} onGeneratePrompt={generateReferencePrompt} onGenerateImage={generateReferenceImage} />}
      {regenerateOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRegenerateOpen(false)}><div ref={regenerateDialogRef} tabIndex={-1} className="project-modal asset-design-modal" role="dialog" aria-modal="true" aria-labelledby="asset-design-title"><div className="modal-head"><div><span className="eyebrow">ASSET DESIGN MODE</span><h2 id="asset-design-title">重做人物与场景设定</h2></div><button type="button" className="close" aria-label="关闭对话框" onClick={() => setRegenerateOpen(false)}>×</button></div><div className="asset-design-options">{(Object.entries(assetDesignModeLabels) as Array<[AssetDesignMode, { title: string; detail: string }]>).map(([value, copy]) => <label className={designMode === value ? "selected" : ""} key={value}><input type="radio" name="asset-design-mode" checked={designMode === value} onChange={() => setDesignMode(value)} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></label>)}</div><div className="rejection-lock"><strong>版本影响与等待时间</strong><p>将创建新的资产定义版本，并让当前导演脚本及后续内容失效；历史文件不会删除。复杂资产通常需要 2–8 分钟，最长等待 12 分钟。</p></div><div className="modal-footer"><button className="secondary" onClick={() => setRegenerateOpen(false)}>取消</button><button className="primary" onClick={() => void regenerate()}>确认并开始生成</button></div></div></div>}
    </section>
  );
}

function StageWorkspace({ project, type, refreshRevision, onBack, onOpenGeneration, onProjectUpdate, onError, onEditStateChange }: {
  project: Project;
  type: ArtifactType;
  refreshRevision: number;
  onBack: () => void;
  onOpenGeneration: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
  onEditStateChange: (state: { projectId: string; type: ArtifactType; dirty: boolean }) => void;
}) {
  const [source, setSource] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [shots, setShots] = useState<ShotSpec[]>([]);
  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const [shotDraft, setShotDraft] = useState<ShotSpec | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string>("");
  const [editor, setEditor] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorInfo, setEditorInfo] = useState<string | null>(null);
  const [draftExpectedLatestArtifactId, setDraftExpectedLatestArtifactId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ArtifactType | null>(null);
  const [assetDesignMode, setAssetDesignMode] = useState<AssetDesignMode>("original-proposal");
  const [runningTarget, setRunningTarget] = useState<ArtifactType | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationElapsedSec, setGenerationElapsedSec] = useState(0);
  const [projectOperation, setProjectOperation] = useState<ProjectOperationStatus | null>(null);
  const [continuityReport, setContinuityReport] = useState<ContinuityReport | null>(null);
  const [continuityReportLoading, setContinuityReportLoading] = useState(false);
  const [continuityReportError, setContinuityReportError] = useState<string | null>(null);
  const [assetReadinessIssues, setAssetReadinessIssues] = useState<string[]>([]);
  const [assetAuthorizationConfirmed, setAssetAuthorizationConfirmed] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const loadEpoch = useRequestEpoch();
  const foregroundRevisionRef = useRef(refreshRevision);
  const generationDialogRef = useDialogFocus<HTMLDivElement>(Boolean(confirmTarget), () => setConfirmTarget(null), Boolean(busy));

  const selected = artifacts.find((item) => item.id === selectedId) ?? artifacts[0] ?? null;
  const latest = artifacts[0] ?? null;
  const compared = artifacts.find((item) => item.id === compareId) ?? null;
  const dirty = editor.trim() !== (selected?.content.trim() ?? "");
  const persistedActiveShot = shots.find((shot) => shot.id === activeShotId) ?? null;
  const shotDirty = Boolean(shotDraft && persistedActiveShot && JSON.stringify(shotDraft) !== JSON.stringify(persistedActiveShot));
  const draftStorageKey = stageDraftStorageKey(project.id, type);

  async function load(preferredId?: string): Promise<boolean> {
    const epoch = ++loadEpoch.current;
    try {
      const [sourceResult, artifactResult, assetResult, shotResult, readinessResult] = await Promise.all([
        api.getSource(project.id),
        api.listArtifacts(project.id, type),
        api.listAssets(project.id),
        api.listShots(project.id),
        type === "asset-bible" ? api.getAssetReadiness(project.id) : Promise.resolve({ passed: true, issues: [] }),
      ]);
      if (epoch !== loadEpoch.current) return false;
      setSource(sourceResult.sourceText);
      setSourcePath(sourceResult.sourcePath);
      setArtifacts(artifactResult.artifacts);
      if (preferredId && typeof window !== "undefined") {
        try { window.sessionStorage.removeItem(draftStorageKey); } catch { /* The saved server version remains authoritative. */ }
      }
      const storedDraft = preferredId ? null : readStoredStageDraft(project.id, type);
      const currentLatestArtifactId = artifactResult.artifacts[0]?.id ?? null;
      const storedBase = artifactResult.artifacts.find((item) => item.id === storedDraft?.baseArtifactId) ?? null;
      const preferred = artifactResult.artifacts.find((item) => item.id === preferredId) ?? storedBase ?? artifactResult.artifacts[0] ?? null;
      setSelectedId(preferred?.id ?? null);
      setEditor(storedDraft?.editor ?? preferred?.content ?? "");
      setDraftExpectedLatestArtifactId(storedDraft?.expectedLatestArtifactId ?? currentLatestArtifactId);
      setCompareId(artifactResult.artifacts.find((item) => item.id !== preferred?.id)?.id ?? "");
      setAssets(assetResult.assets);
      setAssetReadinessIssues(readinessResult.issues);
      setShots(shotResult.shots);
      const recoveredShot = storedDraft?.shotDraft
        ? shotResult.shots.find((shot) => shot.id === storedDraft.shotDraft?.id) ? storedDraft.shotDraft : null
        : null;
      const activeShot = recoveredShot ?? shotResult.shots.find((shot) => shot.id === activeShotId) ?? shotResult.shots[0] ?? null;
      setActiveShotId(activeShot?.id ?? null);
      setShotDraft(activeShot);
      if (storedDraft) {
        const staleBaseline = isDraftBaselineStale(storedDraft.expectedLatestArtifactId, currentLatestArtifactId);
        setEditorInfo(staleBaseline
          ? `已恢复 ${new Date(storedDraft.savedAt).toLocaleString("zh-CN")} 的草稿，但另一个标签页已创建新版本。当前草稿仍绑定旧版本，直接保存会被安全拒绝；请先对比最新版本。`
          : `已恢复本浏览器会话中 ${new Date(storedDraft.savedAt).toLocaleString("zh-CN")} 保存的未提交草稿。`);
      }
      return true;
    } catch (reason) {
      if (epoch !== loadEpoch.current) return false;
      throw reason;
    }
  }

  useEffect(() => {
    const hasDraft = dirty || shotDirty;
    onEditStateChange({ projectId: project.id, type, dirty: hasDraft });
    if (loadingStage || typeof window === "undefined") return;
    try {
      if (hasDraft) {
        const stored: StoredStageDraft = {
          baseArtifactId: selected?.id ?? null,
          expectedLatestArtifactId: draftExpectedLatestArtifactId,
          editor,
          shotDraft: shotDirty ? shotDraft : null,
          savedAt: new Date().toISOString(),
        };
        window.sessionStorage.setItem(draftStorageKey, JSON.stringify(stored));
      } else {
        window.sessionStorage.removeItem(draftStorageKey);
      }
    } catch {
      setEditorInfo("浏览器会话草稿保存失败；离开当前阶段前请先另存正式版本。");
    }
  }, [project.id, type, loadingStage, dirty, shotDirty, editor, shotDraft, selected?.id, draftExpectedLatestArtifactId]);

  useEffect(() => {
    const foregroundRefresh = foregroundRevisionRef.current !== refreshRevision;
    foregroundRevisionRef.current = refreshRevision;
    if (foregroundRefresh && (dirty || shotDirty || Boolean(busy))) {
      setRefreshWarning("检测到其他标签页可能已更新当前阶段；为保护未保存内容，本页没有自动覆盖编辑器。保存时会校验版本基线，冲突时必须刷新并对比。");
      return;
    }
    if (!foregroundRefresh) setLoadingStage(true);
    void load()
      .then((applied) => { if (applied) setLoadingStage(false); })
      .catch((reason: Error) => { onError(reason.message); setLoadingStage(false); });
  }, [project.id, type, refreshRevision]);

  useEffect(() => {
    let cancelled = false;
    setContinuityReport(null);
    setContinuityReportError(null);
    if (type !== "storyboard" || !selected) {
      setContinuityReportLoading(false);
      return () => { cancelled = true; };
    }
    if (typeof selected.metadata.continuityReportStructuredPath !== "string") {
      setContinuityReportLoading(false);
      setContinuityReportError("该版本缺少结构化连续性报告，不能作为有效审批依据；请创建分镜修订版重新生成。");
      return () => { cancelled = true; };
    }
    setContinuityReportLoading(true);
    void api.getContinuityReport(project.id, selected.id)
      .then((result) => {
        if (!cancelled) setContinuityReport(result.report);
      })
      .catch((reason: Error) => {
        if (!cancelled) setContinuityReportError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setContinuityReportLoading(false);
      });
    return () => { cancelled = true; };
  }, [project.id, type, selected?.id, selected?.metadata.continuityReportStructuredPath]);

  useEffect(() => {
    if (generationStartedAt == null) return;
    const update = () => setGenerationElapsedSec(Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt]);

  useEffect(() => {
    if (!busy || !(busy === "generate" || busy === "approve" || busy === "repair" || busy === "continuity-review")) {
      setProjectOperation(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void api.getProjectOperation(project.id)
        .then((result) => { if (!cancelled) setProjectOperation(result.operation); })
        .catch(() => { /* The main mutation response remains authoritative. */ });
    };
    poll();
    const timer = window.setInterval(poll, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [busy, project.id]);

  function selectVersion(id: string) {
    const artifact = artifacts.find((item) => item.id === id) ?? null;
    setSelectedId(id);
    setEditor(artifact?.content ?? "");
    if (compareId === id) setCompareId(artifacts.find((item) => item.id !== id)?.id ?? "");
  }

  function selectShot(id: string) {
    const shot = shots.find((item) => item.id === id) ?? null;
    setActiveShotId(id);
    setShotDraft(shot);
  }

  async function run(label: string, action: () => Promise<{ project: Project; artifact?: Artifact; autoRepair?: AutoContinuityRepairSummary; continuityReview?: StoryboardContinuityReviewSummary }>) {
    const operationStartedAt = Date.now();
    setBusy(label);
    if (label === "generate" || label === "repair" || label === "continuity-review") {
      setGenerationStartedAt(operationStartedAt);
      setGenerationElapsedSec(0);
    }
    setNotice(null);
    setRefreshWarning(null);
    setEditorInfo(null);
    onError(null);
    try {
      const { result, refreshError } = await runMutationWithRefresh({
        mutate: action,
        onSuccess: (operationResult) => onProjectUpdate(operationResult.project),
        refresh: async (operationResult) => {
          if (!operationResult.artifact || operationResult.artifact.type === type) await load(operationResult.artifact?.id);
        },
      });
      if (label === "reject") setComment("");
      if (result.autoRepair && !result.autoRepair.passed) {
        setEditorInfo(`后台自动修复已暂停：${result.autoRepair.blockedReason ?? "仍有无法安全自动处理的问题"}。已保留全部中间版本，剩余 ${result.autoRepair.remainingIssueCodes.length} 项进入二级处理。`);
      }
      if (result.continuityReview?.status === "failed") {
        setEditorInfo(`分镜草案 V${String(result.artifact?.version ?? "?").padStart(3, "0")} 已保存；连续性检查未完成，草案不会丢失。请使用“仅重试连续性检查”，不要重新生成分镜。`);
        setNotice("分镜草案已保留，连续性检查失败并已锁定批准。");
      } else {
        setNotice(label === "save" ? "已另存为不可覆盖的新版本。" : label === "shot-save" ? "镜头修改已保存为新的导演脚本版本，原审批已失效。" : label === "approve" ? "批准成功：审批已绑定版本哈希，项目已进入下一阶段。" : label === "reject" ? "驳回成功：当前版本已锁定，必须产生新版本后才能再次审批。" : label === "continuity-review" ? "连续性检查已完成，报告已绑定当前分镜版本。" : result.autoRepair?.passed ? `后台已完成 ${result.autoRepair.attempts} 轮定点修复与复检；最终分镜已通过，等待你最后确认。` : label === "repair" && result.artifact ? `后台修复已运行 ${result.autoRepair?.attempts ?? 1} 轮并保留全部版本；只有未解决问题需要继续处理。` : `Skill 驱动的 Codex 已完成结构化生成（用时 ${formatElapsed(Math.max(1, Math.round((Date.now() - operationStartedAt) / 1_000)))}），结果等待你的人工审核。` );
      }
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "阶段数据"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
      if (label === "generate" || label === "repair" || label === "continuity-review") {
        setRunningTarget(null);
        setGenerationStartedAt(null);
      }
    }
  }

  function requestGeneration(target: ArtifactType) {
    setConfirmTarget(target);
  }

  function saveEditorVersion() {
    if (selected && !dirty) {
      setNotice(null);
      setEditorInfo(`当前内容与 V${String(selected.version).padStart(3, "0")} 完全相同，未创建重复版本。请先修改正文。`);
      return;
    }
    void run("save", () => api.saveArtifact(project.id, type, editor, selected?.id ?? null, draftExpectedLatestArtifactId));
  }

  function saveShotVersion() {
    if (!shotDraft || !latest) return;
    if (!draftExpectedLatestArtifactId) {
      onError("草稿缺少可校验的导演脚本版本基线；请刷新后重新编辑");
      return;
    }
    void run("shot-save", () => api.updateShot(project.id, shotDraft, draftExpectedLatestArtifactId));
  }

  async function confirmGeneration() {
    const target = confirmTarget;
    if (!target) return;
    setConfirmTarget(null);
    setRunningTarget(target);
    await run("generate", () => api.generateArtifact(project.id, target, target === "asset-bible" ? { designMode: assetDesignMode } : undefined));
  }

  async function retryContinuityReview() {
    if (!selected) return;
    setRunningTarget("storyboard");
    await run("continuity-review", () => api.reviewStoryboardContinuity(project.id, selected.id));
  }

  async function approveCurrentArtifact() {
    if (!latest) return;
    setBusy("approve");
    setRunningTarget(null);
    setNotice(null);
    setRefreshWarning(null);
    setEditorInfo(null);
    onError(null);
    try {
      const approval = await api.decide(project.id, project.currentStage, latest.id, "approve", comment);
      onProjectUpdate(approval.project);
      setComment("");
      await load(latest.id);
      setNotice("批准成功：审批只绑定当前版本，没有启动后续生成或粗剪。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "批准失败");
    } finally {
      setBusy(null);
      setRunningTarget(null);
      setGenerationStartedAt(null);
    }
  }

  async function applyReliableDuration(targetDurationSec: number) {
    if (typeof window !== "undefined" && !window.confirm(`将项目时长从 ${project.targetDurationSec} 秒调整为 ${targetDurationSec} 秒，并从原始内容重新生成大纲。所有历史版本都会保留但标记为过期。是否继续？`)) return;
    setBusy("duration");
    onError(null);
    try {
      const result = await api.reviseTargetDuration(project.id, targetDurationSec);
      onProjectUpdate(result.project);
      setNotice(`目标时长已调整为 ${targetDurationSec} 秒；旧产物完整保留，工作流已回到大纲生成入口。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "目标时长调整失败");
    } finally {
      setBusy(null);
    }
  }

  async function continueTargetedRepair() {
    await run("repair", () => api.continueContinuityRepair(project.id));
  }

  async function uploadReference(assetId: string, file: File, role: string) {
    loadEpoch.current += 1;
    setBusy(`upload:${assetId}`);
    onError(null);
    try {
      validateReferenceUpload(file);
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      setRefreshWarning(null);
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.uploadAssetReference(project.id, assetId, { fileName: file.name, mimeType: file.type, dataBase64, role, authorizationConfirmed: true }),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => {
          const readiness = await api.getAssetReadiness(project.id);
          setAssetReadinessIssues(readiness.issues);
        },
      });
      setNotice(`${assetId} 的${role}参考图已保存并绑定。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "资产制作检查"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图上传失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function replaceReference(assetId: string, index: number, file: File) {
    loadEpoch.current += 1;
    setBusy(`replace:${assetId}:${index}`);
    onError(null);
    try {
      validateReferenceUpload(file);
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      setRefreshWarning(null);
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.replaceAssetReference(project.id, assetId, index, { fileName: file.name, mimeType: file.type, dataBase64, authorizationConfirmed: true }),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => {
          const readiness = await api.getAssetReadiness(project.id);
          setAssetReadinessIssues(readiness.issues);
        },
      });
      setNotice(`${assetId} 的第 ${index + 1} 张参考图已安全更换；旧图保留在项目历史回收目录。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "资产制作检查"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图更换失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function deleteReference(assetId: string, index: number) {
    loadEpoch.current += 1;
    setBusy(`delete:${assetId}:${index}`);
    onError(null);
    try {
      setRefreshWarning(null);
      const { refreshError } = await runMutationWithRefresh({
        mutate: () => api.deleteAssetReference(project.id, assetId, index),
        onSuccess: (result) => setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset)),
        refresh: async () => {
          const readiness = await api.getAssetReadiness(project.id);
          setAssetReadinessIssues(readiness.issues);
        },
      });
      setNotice(`${assetId} 的参考图已删除绑定；原文件已移入项目历史回收目录。`);
      if (refreshError) setRefreshWarning(formatRefreshWarning(refreshError, "资产制作检查"));
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图删除失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function generateReferencePrompt(assetId: string, role: AssetReferenceRole) {
    loadEpoch.current += 1;
    setBusy(`prompt:${assetId}`);
    setNotice(null);
    onError(null);
    try {
      const result = await api.generateAssetReferencePrompt(project.id, assetId, role);
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      setNotice(`${assetId} 的${role}参考图提示词已由本地 Codex 生成并保存。`);
      return { prompt: result.prompt, imageProvider: result.imageProvider };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图提示词生成失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function generateReferenceImage(assetId: string, promptId: string) {
    loadEpoch.current += 1;
    setBusy(`image:${assetId}`);
    onError(null);
    try {
      const result = await api.generateAssetReferenceImage(project.id, assetId, promptId);
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      const readiness = await api.getAssetReadiness(project.id);
      setAssetReadinessIssues(readiness.issues);
      setNotice(`${assetId} 的参考图已由图像 Provider 生成、校验并绑定。`);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("参考图生成失败");
      onError(error.message);
      throw error;
    } finally {
      setBusy(null);
    }
  }

  const targetStepIndex = projectWorkbenchSteps.findIndex((step) => step.artifactType === type);
  const currentStepIndex = currentProjectStepIndex(project.currentStage);
  const isActiveArtifactStage = targetStepIndex >= 0 && projectWorkbenchSteps[targetStepIndex].stages.includes(project.currentStage);
  const canCreateRevision = targetStepIndex >= 0 && targetStepIndex <= currentStepIndex;
  const isCurrentReview = project.currentStage === reviewStageByArtifact[type];
  const h3IncompatibleShots = type === "shooting-script" ? shots.filter((shot) => !isH3ProductDurationCompatible(shot.durationSec, 4, 15)
    || !Number.isInteger(shot.startTimeSec)
    || !Number.isInteger(shot.endTimeSec)) : [];
  const generationReadiness = artifactGenerationReadiness(selected);
  const readinessBlocked = generationReadiness?.status === "blocked";
  const acknowledgementMissing = Boolean(generationReadiness?.acknowledgementRequired && !comment.trim());
  const manualStructureAcknowledgementMissing = Boolean((type === "outline" || type === "screenplay") && selected && !selected.structuredPath && !comment.trim());
  const shootingExecutionIssues = type === "shooting-script" ? inspectShootingScriptPreflight(shots, {
    recommendedMinimumShots: generationReadiness?.recommendedMinimumShots,
  }) : [];
  const incompleteAssets = type === "asset-bible" ? assets.filter(assetNeedsDesign) : [];
  const continuityBlocked = type === "storyboard" && Boolean(selected) && selected?.metadata.continuityPassed !== true;
  const storyboardVerification = type === "storyboard" && selected?.metadata.verification && typeof selected.metadata.verification === "object"
    ? selected.metadata.verification as Record<string, unknown>
    : null;
  const modelVerificationBlocked = type === "storyboard" && storyboardVerification?.modelExecutability !== "passed";
  const isReviewableDraft = Boolean(isCurrentReview && latest?.status === "draft" && selected?.id === latest.id);
  const canApprove = Boolean(isReviewableDraft
    && !h3IncompatibleShots.length
    && !shootingExecutionIssues.length
    && !assetReadinessIssues.length
    && !continuityBlocked
    && !modelVerificationBlocked
    && !readinessBlocked
    && !acknowledgementMissing
    && !manualStructureAcknowledgementMissing);
  const canReject = Boolean(isReviewableDraft && comment.trim());
  const continuityIssues = continuityReport ? [...continuityReport.issues].sort((left, right) => ({ error: 0, warning: 1, info: 2 }[left.severity] - { error: 0, warning: 1, info: 2 }[right.severity])) : [];
  const continuityErrorCount = continuityIssues.filter((issue) => issue.severity === "error").length;
  const continuityWarningCount = continuityIssues.filter((issue) => issue.severity === "warning").length;
  const continuityIssueGroups = groupContinuityIssues(continuityIssues);
  const suggestions = type === "outline"
    ? extractSuggestions(selected?.content ?? "")
    : type === "screenplay"
      ? "剧本阶段只根据已批准大纲展开，不会在此自动改变故事结构。"
      : type === "asset-bible"
        ? "资产只描述逻辑身份与连续性；本地文件、哈希和上传状态必须由程序实测。"
        : type === "shooting-script"
          ? "时间码、总时长和资产引用均由程序再次校验；镜头修改会产生新版本。"
          : selected?.metadata.continuityPassed === true
            ? `连续性检查已通过；报告记录 ${String(selected.metadata.continuityIssueCount ?? 0)} 个问题。`
            : "连续性检查未通过，必须重新生成或修正上游内容。";
  const executedSkills = artifactSkills(selected);
  const nextTarget = isActiveArtifactStage ? nextArtifactByApprovedStage[project.currentStage] ?? null : null;
  const continuityRepairNext = latest?.status === "approved" && typeof latest.metadata.continuityRepairNext === "string"
    ? latest.metadata.continuityRepairNext as ArtifactType
    : null;
  const continuingTargetedRepair = Boolean(nextTarget && continuityRepairNext === nextTarget);
  const continuityReviewNeedsRetry = Boolean(type === "storyboard"
    && selected?.id === latest?.id
    && selected?.status === "draft"
    && ["pending", "failed"].includes(String(selected.metadata.continuityReviewStatus ?? "")));
  const operationPhaseElapsedSec = projectOperation
    ? Math.max(0, Math.floor((Date.now() - Date.parse(projectOperation.phaseStartedAt)) / 1_000))
    : generationElapsedSec;
  const operationPhaseLabel = projectOperation?.phaseLabel
    ?? (busy === "continuity-review" ? "正在单独检查分镜连续性" : runningTarget ? `Skill 正在驱动 Codex 生成${artifactLabels[runningTarget]}` : "正在处理");
  const structuredStage = !(["outline", "screenplay"] as ArtifactType[]).includes(type);
  const diffRows = compared ? editor.split(/\r?\n/).map((line, index) => ({ current: line, previous: compared.content.split(/\r?\n/)[index] ?? "" })).filter((row) => row.current !== row.previous).slice(0, 60) : [];

  if (loadingStage) return <div className="empty-state"><div className="loader" /><p>正在载入阶段版本…</p></div>;

  return (
    <section className="stage-workbench">
      <div className="workbench-head">
        <div><button className="back-link" onClick={onBack}>← 返回项目总览</button><span className="eyebrow">PROJECT WORKBENCH</span><h1>{project.title} · {artifactLabels[type]}</h1><p>{isActiveArtifactStage ? stageLabels[project.currentStage] : `正在回顾${artifactLabels[type]} · 项目当前位于${stageLabels[project.currentStage]}`} · 所有修改均另存新版本</p></div>
        <div className="workbench-head-actions">
          <div>{nextTarget ? continuingTargetedRepair ? <button className="primary repair-action" disabled={Boolean(busy)} onClick={() => void continueTargetedRepair()}>{busy === "repair" ? "正在后台修复…" : `继续后台修复${artifactLabels[nextTarget]} →`}</button> : <button className="primary" disabled={Boolean(busy)} onClick={() => requestGeneration(nextTarget)}>{busy === "generate" ? `Skill 正在生成${artifactLabels[nextTarget]}…` : `使用 Skill 生成${artifactLabels[nextTarget]} →`}</button> :
            <button className="secondary stage-regenerate-action" disabled={!canCreateRevision || Boolean(busy)} onClick={() => requestGeneration(type)}>{busy === "generate" ? `Skill 正在生成${artifactLabels[type]}…` : canCreateRevision ? `${latest ? "创建" : "生成"}${artifactLabels[type]}修订版` : "等待前置步骤"}</button>}</div>
          {isCurrentReview && <button className="primary stage-approve-action" disabled={!canApprove || Boolean(busy)} onClick={() => void approveCurrentArtifact()}>{busy === "approve" ? "正在批准当前版本…" : "批准当前版本"}</button>}
        </div>
      </div>

      {notice && <div className="success-notice" role="status" aria-live="polite">✓ {notice}</div>}
      <RefreshWarning message={refreshWarning} />
      {editorInfo && <div className="info-notice">! {editorInfo}</div>}
      {(busy === "generate" || busy === "continuity-review") && runningTarget && <div className="generation-progress"><div className="loader mini" /><div><strong>{operationPhaseLabel} · 本阶段 {formatElapsed(operationPhaseElapsedSec)}</strong><p>{runningTarget === "storyboard" ? `分镜草案生成成功后会立即保存；连续性检查独立运行、失败可单独重试。总计已等待 ${formatElapsed(generationElapsedSec)}。` : `${generationExpectations[runningTarget]}。生成完成后会停在新草案审核，不会自动批准内容。`}</p></div><b>{formatElapsed(generationElapsedSec)}</b></div>}
      {busy === "repair" && <div className="generation-progress"><div className="loader mini" /><div><strong>后台正在逐层修复并复检 · 已等待 {formatElapsed(generationElapsedSec)}</strong><p>最多自动循环 3 轮；中间技术版本自动推进，最终分镜仍由你确认，付费视频不会被自动重复生成。</p></div><b>{formatElapsed(generationElapsedSec)}</b></div>}
      {h3IncompatibleShots.length > 0 && <div className="rejection-lock"><strong>当前导演脚本无法进入 H3 投递</strong><p>产品生产规则要求每镜 5–15 的整数秒；当前 {h3IncompatibleShots.length} 个镜头不兼容（{h3IncompatibleShots.map((shot) => `${shot.id} ${shot.durationSec}s`).join("、")}）。15 秒可使用 8+7、9+6 或 5+5+5，请驳回当前版本并重新生成。</p></div>}
      {generationReadiness && <div className={`generation-readiness-card ${generationReadiness.status}`}>
        <strong>{generationReadiness.status === "blocked" ? "付费生成预算未通过" : "付费生成预算已计算"}</strong>
        <p>预计 {generationReadiness.estimatedMajorBeats} 个主要剧情 Beat；建议至少 {generationReadiness.recommendedMinimumShots} 镜，当前时长最多容纳 {generationReadiness.maximumProductShots} 镜。</p>
        {generationReadiness.issues.map((issue) => <p className={issue.severity === "error" ? "preflight-error" : "preflight-warning"} key={issue.code}><b>{issue.code}</b> · {issue.message} {issue.suggestedFix}</p>)}
        {generationReadiness.acknowledgementRequired && <p>批准前必须在审批意见中明确选择：{generationReadiness.acknowledgementReasons.slice(0, 3).join("；")}</p>}
        {generationReadiness.status === "blocked" && generationReadiness.minimumReliableDurationSec > project.targetDurationSec && <button className="secondary" disabled={Boolean(busy)} onClick={() => void applyReliableDuration(generationReadiness.minimumReliableDurationSec)}>调整为至少 {generationReadiness.minimumReliableDurationSec} 秒并从大纲重做</button>}
      </div>}
      {shootingExecutionIssues.length > 0 && <div className="rejection-lock"><strong>导演脚本模型可执行性未通过 · {shootingExecutionIssues.length} 项</strong><p>{shootingExecutionIssues.map((issue) => `${issue.code}：${issue.message}`).join("；")}</p><p>系统不会允许该版本进入付费视频投递；请重新生成或返回真实剧情转折处拆镜。</p></div>}
      {modelVerificationBlocked && <div className="rejection-lock"><strong>模型可执行性尚未通过</strong><p>文字连续性检查不能替代视频模型执行检查。当前分镜必须重新按新规则生成，才能批准进入付费投递。</p></div>}
      {assetReadinessIssues.length > 0 && <div className="rejection-lock"><strong>当前资产定义不能批准 · {assetReadinessIssues.length} 项检查未通过</strong><p>{assetReadinessIssues.join("；")}</p>{incompleteAssets.length > 0 && <p>{incompleteAssets.map((asset) => `${asset.id} ${asset.name}`).join("、")} 可通过原创完整设定重新生成，或上传有效参考图补齐。</p>}</div>}
      {type === "storyboard" && selected && <section className={`continuity-report-card ${continuityReport?.passed ? "passed" : "blocked"}`} aria-live="polite">
        <header><div><span>06 / 分镜审核 · V{String(selected.version).padStart(3, "0")}</span><strong>{continuityReportLoading ? "正在读取检查结果…" : continuityReportError ? "检查证据缺失" : continuityReport?.passed ? "可以进入人工确认" : selected.metadata.continuityReviewStatus === "failed" ? "检查未完成，草案已保留" : "当前版本不能批准"}</strong></div>{(continuityReport || continuityReviewNeedsRetry) && <div className="continuity-report-actions">{continuityReport && <b>{continuityReport.passed ? "检查通过" : `${continuityIssueGroups.length} 类问题`}</b>}{continuityReviewNeedsRetry && <button className="primary" disabled={Boolean(busy)} onClick={() => void retryContinuityReview()}>{busy === "continuity-review" ? "正在重新检查…" : "重新检查"}</button>}</div>}</header>
        {!continuityReportLoading && continuityReport && !continuityReport.passed && <div className="continuity-next-step"><span>下一步</span><div><strong>先处理 {continuityIssueGroups.length} 类核心问题</strong><p>{continuityErrorCount + continuityWarningCount} 条检查证据已按根因归并。系统不会自动修改上游内容。</p></div></div>}
        {continuityReportError && <div className="continuity-report-read-error" role="alert"><strong>检查结果不可用</strong><p>{continuityReportError}</p></div>}
        {!continuityReportLoading && continuityReport && <div className="continuity-priority-list">
          {continuityIssueGroups.length ? continuityIssueGroups.map((group, index) => <details className={`continuity-problem-group ${group.severity}`} key={group.code}>
            <summary><span className="continuity-priority-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{continuityIssueGroupTitle(group)}</strong><small>{group.affectedIds.length ? `影响 ${group.affectedIds.join("、")}` : "全局检查"}{group.issues.length > 1 ? ` · ${group.issues.length} 条证据` : ""}</small></div><b>{group.requiresReapproval ? "需修订" : group.severity === "error" ? "阻塞" : "检查"}</b></summary>
            <div className="continuity-problem-body"><code>{group.code}</code>{group.issues.length > 1 ? <ul>{group.issues.map((issue, issueIndex) => <li key={`${issue.code}-${issueIndex}`}>{issue.message}</li>)}</ul> : <p>{group.issues[0].message}</p>}<div className="continuity-fix"><span>处理建议</span>{group.suggestedFixes.map((fix) => <p key={fix}>{fix}</p>)}</div></div>
          </details>) : <p className="continuity-empty">未发现连续性问题。</p>}
        </div>}
        {!continuityReportLoading && continuityReport && continuityReport.uncheckedClaims.length > 0 && <details className="continuity-evidence-details"><summary>技术证据与尚未验证项 · {continuityReport.uncheckedClaims.length}</summary><ul>{continuityReport.uncheckedClaims.map((claim, index) => <li key={`${index}-${claim}`}>{claim}</li>)}</ul></details>}
      </section>}
      {nextTarget && <div className="stage-complete-card"><span>✓</span><div><strong>{artifactLabels[type]}已经批准并锁定</strong><p>{continuingTargetedRepair ? `后台修复链路仍有一步：只更新受影响的${artifactLabels[nextTarget]}对象，其他内容保持原样。` : `审批哈希已写入本地记录。下一步将严格依据已批准版本生成${artifactLabels[nextTarget]}，不会自动批准。`}</p></div><button className={`primary ${continuingTargetedRepair ? "repair-action" : ""}`} disabled={Boolean(busy)} onClick={() => continuingTargetedRepair ? void continueTargetedRepair() : requestGeneration(nextTarget)}>{continuingTargetedRepair ? `继续后台修复${artifactLabels[nextTarget]} →` : `进入${artifactLabels[nextTarget]}阶段 →`}</button></div>}
      {project.currentStage === "STORYBOARD_APPROVED" && <div className="stage-complete-card"><span>✓</span><div><strong>Phase 3 已完成</strong><p>资产、ShotSpec、分镜和连续性报告均已形成批准版本；下一阶段将进入 H3 与 Updream 投递。</p></div></div>}
      <details className={`stage-detail-disclosure ${type !== "storyboard" ? "always-open" : ""}`} open={type !== "storyboard" ? true : undefined}>
        {type === "storyboard" && <summary><div><strong>完整内容与版本记录</strong><small>分镜正文、原始内容、历史版本和审批记录</small></div><b>{selected ? `V${String(selected.version).padStart(3, "0")} · ${artifacts.length} 个版本` : "尚无版本"}</b></summary>}
        <div className={`three-column-workbench ${type === "asset-bible" ? "asset-stage-workbench" : ""}`}>
        <article className="work-panel source-panel">
          <div className="work-panel-head"><span>01 / 原始内容</span><b>LOCKED</b></div>
          <p className="panel-help">不可变原件，仅供逐项核对。</p>
          <pre>{source}</pre>
          <code title={sourcePath}>{sourcePath}</code>
        </article>

        <article className="work-panel editor-panel">
          <div className="work-panel-head"><span>02 / 当前版本</span><b>{selected ? `V${String(selected.version).padStart(3, "0")}` : "未生成"}</b></div>
          <div className="version-tools">
            <label>编辑版本<select value={selected?.id ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={Boolean(busy) || !artifacts.length}>{artifacts.length ? artifacts.map((item) => <option key={item.id} value={item.id}>V{String(item.version).padStart(3, "0")} · {artifactStatusLabels[item.status]}</option>) : <option value="">尚无版本</option>}</select></label>
            <label>对比版本<select value={compareId} onChange={(event) => setCompareId(event.target.value)} disabled={Boolean(busy) || artifacts.length < 2}><option value="">不对比</option>{artifacts.filter((item) => item.id !== selected?.id).map((item) => <option key={item.id} value={item.id}>V{String(item.version).padStart(3, "0")}</option>)}</select></label>
          </div>
          {type === "asset-bible" ? <AssetBiblePanel assets={assets} projectId={project.id} editable={canCreateRevision} busy={busy} authorizationConfirmed={assetAuthorizationConfirmed} onAuthorizationChange={setAssetAuthorizationConfirmed} onUpload={uploadReference} onReplace={replaceReference} onDelete={deleteReference} onGeneratePrompt={generateReferencePrompt} onGenerateImage={generateReferenceImage} /> : type === "shooting-script" ? <ShotEditor shots={shots} activeShotId={activeShotId} draft={shotDraft} busy={Boolean(busy)} onSelect={selectShot} onChange={setShotDraft} onSave={saveShotVersion} /> : <textarea className={structuredStage ? "structured-preview" : ""} readOnly={structuredStage} disabled={Boolean(busy)} value={editor} onChange={(event) => { setEditor(event.target.value); setEditorInfo(null); }} placeholder={`使用 Skill 生成${artifactLabels[type]}草案…`} />}
          <div className="editor-footer"><span>{selected ? `${artifactStatusLabels[selected.status]} · SHA256 ${selected.contentHash.slice(0, 10)}…` : "尚未创建产物文件"}</span>{!structuredStage && <button className="secondary" disabled={!canCreateRevision || Boolean(busy) || !editor.trim()} onClick={saveEditorVersion}>{busy === "save" ? "正在保存…" : dirty || !selected ? "另存为新版本" : "检查并另存"}</button>}</div>
          {compared && <div className="diff-card"><div><strong>与 V{String(compared.version).padStart(3, "0")} 的逐行差异</strong><small>{diffRows.length ? `显示 ${diffRows.length} 处` : "内容相同"}</small></div>{diffRows.map((row, index) => <p key={`${index}-${row.current}`}><del>{row.previous || "（空）"}</del><ins>{row.current || "（空）"}</ins></p>)}</div>}
        </article>

        {type !== "asset-bible" && <article className="work-panel review-panel">
          <div className="work-panel-head"><span>03 / 建议与审批</span><b>HUMAN ONLY</b></div>
          <p className="panel-help">Codex 只能生成草案，不能替你批准。</p>
          <div className={`skill-execution-card ${executedSkills.length ? "active" : "manual"}`}>
            <small>实际执行链路</small>
            {executedSkills.length ? <><strong>{executedSkills.map((skill) => skill.name).join(" → ")}</strong>{executedSkills.map((skill) => <code key={`${skill.name}-${skill.sha256}`}>{skill.name} · v{skill.version} · {skill.sha256.slice(0, 10)}…</code>)}</> : <><strong>无 Skill 执行记录</strong><p>这是旧版产物或人工编辑版本。</p></>}
          </div>
          <div className="suggestion-box"><small>{type === "outline" ? "剧情修改建议" : "结构约束"}</small><p>{suggestions}</p></div>
          {latest?.status === "rejected" && <div className="rejection-lock"><strong>当前版本已驳回并锁定</strong><p>不能再次批准同一文件。请在中间栏修改后“另存为新版本”，或点击上方重新生成。</p></div>}
          <div className="approval-facts"><div><span>当前版本</span><b>{selected ? `V${String(selected.version).padStart(3, "0")}` : "无"}</b></div><div><span>审批状态</span><b>{selected ? artifactStatusLabels[selected.status] : "等待生成"}</b></div><div><span>历史版本</span><b>{artifacts.length}</b></div></div>
          <label className="review-comment"><span>审批意见（驳回必填；存在方案选择时批准也必填）</span><textarea disabled={Boolean(busy)} value={comment} onChange={(event) => setComment(event.target.value)} placeholder={generationReadiness?.acknowledgementRequired ? "请明确写明采用哪一种时长、拆镜或剧情方案…" : "驳回时请写明修改要求…"} /></label>
          <div className="approval-actions"><button className="danger secondary" disabled={!canReject || Boolean(busy)} onClick={() => latest && void run("reject", () => api.decide(project.id, project.currentStage, latest.id, "reject", comment))}>驳回并锁定</button></div>
          {!canApprove && <p className="gate-note">{!isCurrentReview ? `当前处于${artifactLabels[type]}回顾模式。可以查看任意历史版本，编辑或重新生成会创建修订版并把项目带回本阶段审核。` : readinessBlocked ? "批准按钮已锁定：当前故事复杂度无法在目标时长内可靠生成，请延长时长或删减事件。" : acknowledgementMissing ? "批准按钮已锁定：请先在审批意见中明确采用哪一种方案。" : manualStructureAcknowledgementMissing ? "批准按钮已锁定：这是人工文本版本，缺少结构化复杂度数据；请填写审批意见明确确认。" : shootingExecutionIssues.length ? "批准按钮已锁定：当前镜头复杂度仍可能浪费付费生成次数。" : modelVerificationBlocked ? "批准按钮已锁定：模型可执行性检查未通过，结构一致性通过不能代替它。" : continuityBlocked ? "批准按钮已锁定：请查看页面上方的连续性明细，按建议修复后生成新分镜版本；当前版本仍可填写意见后驳回。" : assetReadinessIssues.length ? "批准按钮已锁定：页面上方已列出全部资产制作检查问题；修复后才能批准，当前版本仍可驳回。" : h3IncompatibleShots.length ? "批准按钮已锁定：先驳回并生成符合 5–15 整数秒限制的新版本。" : latest?.status === "rejected" ? "该版本已驳回；只有新生成或另存的版本才能再次审批。" : latest && selected?.id !== latest.id ? "历史版本只读回看；只能审批最新版本。" : "生成或保存一个版本后才能审批。"}</p>}
        </article>}
        </div>
      </details>
      {type === "asset-bible" && <details className="asset-secondary-review"><summary><span>问题处理与审批详情</span><small>仅在需要驳回、填写意见或查看技术记录时展开</small></summary><div className="asset-secondary-review-body">
        <div className={`skill-execution-card ${executedSkills.length ? "active" : "manual"}`}><small>实际执行链路</small>{executedSkills.length ? <><strong>{executedSkills.map((skill) => skill.name).join(" → ")}</strong>{executedSkills.map((skill) => <code key={`${skill.name}-${skill.sha256}`}>{skill.name} · v{skill.version} · {skill.sha256.slice(0, 10)}…</code>)}</> : <><strong>无 Skill 执行记录</strong><p>这是旧版产物或人工编辑版本。</p></>}</div>
        <div className="suggestion-box"><small>结构约束</small><p>{suggestions}</p></div>
        {latest?.status === "rejected" && <div className="rejection-lock"><strong>当前版本已驳回并锁定</strong><p>不能再次批准同一文件。请修改后创建新版本，或使用顶部重新生成。</p></div>}
        <div className="approval-facts"><div><span>当前版本</span><b>{selected ? `V${String(selected.version).padStart(3, "0")}` : "无"}</b></div><div><span>审批状态</span><b>{selected ? artifactStatusLabels[selected.status] : "等待生成"}</b></div><div><span>历史版本</span><b>{artifacts.length}</b></div></div>
        <label className="review-comment"><span>审批意见（驳回时必填）</span><textarea disabled={Boolean(busy)} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写明需要修改的问题…" /></label>
        <div className="approval-actions"><button className="danger secondary" disabled={!canReject || Boolean(busy)} onClick={() => latest && void run("reject", () => api.decide(project.id, project.currentStage, latest.id, "reject", comment))}>驳回并锁定</button></div>
        {!canApprove && <p className="gate-note">{!isCurrentReview ? "当前处于资产定义回顾模式；可以查看、补充或创建修订版，原历史不会覆盖。" : assetReadinessIssues.length ? "顶部批准按钮已锁定：页面上方已列出全部资产制作检查问题。" : latest?.status === "rejected" ? "该版本已驳回；只有新生成版本才能再次审批。" : latest && selected?.id !== latest.id ? "历史版本只读回看；只能审批最新版本。" : "生成一个版本后才能审批。"}</p>}
      </div></details>}
      {confirmTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmTarget(null)}><div ref={generationDialogRef} tabIndex={-1} className="project-modal generation-confirm" role="dialog" aria-modal="true" aria-labelledby="generation-confirm-title"><div className="modal-head"><div><span className="eyebrow">SKILL-DRIVEN CODEX</span><h2 id="generation-confirm-title">生成{artifactLabels[confirmTarget]}草案</h2></div><button type="button" className="close" aria-label="关闭对话框" onClick={() => setConfirmTarget(null)}>×</button></div><div className="generation-confirm-body"><div className="generation-symbol">AI</div><div><strong>即将由本地 Skill 驱动真实 Codex 任务</strong><p>系统会显式加载 producer、当前阶段 Skill 与已批准上游内容。不会调用付费视频 API，也不会自动批准结果。</p></div>{confirmTarget === "asset-bible" && <div className="asset-design-options compact-options">{(Object.entries(assetDesignModeLabels) as Array<[AssetDesignMode, { title: string; detail: string }]>).map(([value, copy]) => <label className={assetDesignMode === value ? "selected" : ""} key={value}><input type="radio" name="stage-asset-design-mode" checked={assetDesignMode === value} onChange={() => setAssetDesignMode(value)} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></label>)}</div>}<dl><div><dt>Skill 路由</dt><dd>{generationRoutes[confirmTarget]}</dd></div><div><dt>预计等待</dt><dd>{generationExpectations[confirmTarget]}</dd></div><div><dt>权限</dt><dd>只读本地项目</dd></div><div><dt>生成后</dt><dd>停在人工审核</dd></div></dl></div><div className="modal-footer"><button type="button" className="secondary" onClick={() => setConfirmTarget(null)}>取消</button><button type="button" className="primary" onClick={() => void confirmGeneration()}>确认并开始生成</button></div></div></div>}
    </section>
  );
}

const assetTypeLabels: Record<Asset["type"], string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服装",
  style: "风格",
  audio: "声音",
  reference: "参考",
};
const visualAssetTypesForUi = new Set<Asset["type"]>(["character", "scene", "prop", "costume", "style", "reference"]);

function assetMediaType(asset: Asset): "图片" | "音频" {
  return asset.type === "audio" ? "音频" : "图片";
}

function referencePromptClipboardText(prompt: AssetReferencePromptRecord, includeEnglish = false): string {
  return [`中文提示词：${prompt.promptZh}`, ...(includeEnglish ? [`英文提示词：${prompt.promptEn}`] : []), `负面提示词：${prompt.negativePrompt}`].join("\n\n");
}

function AssetBiblePanel({ assets, projectId, editable = false, busy = null, authorizationConfirmed = false, onAuthorizationChange, onUpload, onReplace, onDelete, onGeneratePrompt, onGenerateImage }: {
  assets: Asset[];
  projectId?: string;
  editable?: boolean;
  busy?: string | null;
  authorizationConfirmed?: boolean;
  onAuthorizationChange?: (confirmed: boolean) => void;
  onUpload?: (assetId: string, file: File, role: string) => Promise<void>;
  onReplace?: (assetId: string, index: number, file: File) => Promise<void>;
  onDelete?: (assetId: string, index: number) => Promise<void>;
  onGeneratePrompt?: (assetId: string, role: AssetReferenceRole) => Promise<{ prompt: AssetReferencePromptRecord; imageProvider: ImageProviderCapabilities }>;
  onGenerateImage?: (assetId: string, promptId: string) => Promise<void>;
}) {
  const [roles, setRoles] = useState<Record<string, AssetReferenceRole>>({});
  const [uploadFeedback, setUploadFeedback] = useState<Record<string, { kind: "success" | "error"; message: string }>>({});
  const [promptFeedback, setPromptFeedback] = useState<Record<string, { kind: "success" | "error"; message: string }>>({});
  const [includeEnglishByAsset, setIncludeEnglishByAsset] = useState<Record<string, boolean>>({});
  const [imageProvider, setImageProvider] = useState<ImageProviderCapabilities | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ assetId: string; assetName: string; index: number; role: string } | null>(null);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), () => setDeleteTarget(null), Boolean(busy));
  const activeAsset = assets.find((asset) => asset.id === activeAssetId) ?? null;
  const assetDetailDialogRef = useDialogFocus<HTMLDivElement>(Boolean(activeAsset), () => setActiveAssetId(null), Boolean(busy));
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void api.getImageProviderCapabilities()
      .then((capabilities) => { if (active) setImageProvider(capabilities); })
      .catch(() => { if (active) setImageProvider(null); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (activeAssetId && !assets.some((asset) => asset.id === activeAssetId)) setActiveAssetId(null);
  }, [activeAssetId, assets]);
  if (!assets.length) return <div className="structured-empty"><strong>尚未生成资产定义</strong><p>批准影视剧本后，使用 Skill 提取角色、场景、道具、服装、风格与声音。</p></div>;
  const activeRole = activeAsset ? roles[activeAsset.id] ?? "主参考" : "主参考";
  const activeLatestPrompt = activeAsset ? [...activeAsset.referencePrompts].reverse().find((item) => item.role === activeRole) ?? activeAsset.referencePrompts.at(-1) ?? null : null;
  const activeIncludeEnglish = activeAsset ? Boolean(includeEnglishByAsset[activeAsset.id]) : false;
  return (
    <div className="asset-bible-grid">
      {editable && <div className="asset-image-provider-state"><div><strong>参考图生成</strong><p>本地 Codex 负责生成详细提示词；真实图片由独立 Provider 输出。</p></div><b className={imageProvider?.enabled ? "online" : "reserved"}>{imageProvider?.enabled ? `${imageProvider.displayName} 已启用` : "付费图像 API 已预留 · 当前关闭"}</b></div>}
      {editable && onUpload && <label className="check full asset-authorization"><input type="checkbox" checked={authorizationConfirmed} onChange={(event) => onAuthorizationChange?.(event.target.checked)} /><span>仅上传自有图片时勾选：我确认拥有参考图使用权限，并同意保存到当前本地项目</span></label>}
      {assets.map((asset) => {
        const mediaType = assetMediaType(asset);
        return <article id={`asset-card-${asset.id}`} tabIndex={0} role="button" aria-label={`${asset.name}资产详情，按回车打开`} className={`asset-definition-card asset-summary-card asset-type-${asset.type} ${assetNeedsDesign(asset) ? "incomplete" : "ready"}`} key={asset.id} onDoubleClick={() => setActiveAssetId(asset.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveAssetId(asset.id); } }}>
        <div className="asset-card-meta"><span className="asset-card-id">{asset.id}</span><div className="asset-type-badges"><strong className={`asset-media-badge ${mediaType === "音频" ? "audio" : "image"}`}>{mediaType}</strong><span className={`asset-category-badge ${asset.type}`}>{assetTypeLabels[asset.type]}</span>{assetNeedsDesign(asset) && <em>设定需补充</em>}</div></div>
        <h3>{asset.name}</h3>
        <p>{asset.identity}</p>
        {projectId && asset.localFiles.length > 0 && <div className="asset-reference-preview" aria-label={`已绑定 ${asset.localFiles.length} 张参考图`}>{asset.localFiles.slice(0, 3).map((_file, index) => <img key={`${asset.id}-preview-${asset.sha256[index] ?? index}`} src={api.assetReferenceUrl(projectId, asset.id, index)} alt="" />)}{asset.localFiles.length > 3 && <span>+{asset.localFiles.length - 3}</span>}</div>}
        <footer><span>{assetNeedsDesign(asset) ? asset.approved ? "旧版批准 · 现已拦截" : "不可批准" : asset.approved ? "已批准" : "待审核"}</span><code>V{String(asset.version).padStart(3, "0")} · {asset.localFiles.length} 图</code></footer>
      </article>})}
      {activeAsset && <div className="modal-backdrop asset-detail-backdrop" role="presentation" onDoubleClick={(event) => { if (event.target === event.currentTarget && !busy) setActiveAssetId(null); }}><div ref={assetDetailDialogRef} tabIndex={-1} className="project-modal asset-detail-modal" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title"><div className="modal-head asset-detail-head" onDoubleClick={() => { if (!busy) setActiveAssetId(null); }}><div><span className="eyebrow">{activeAsset.id} · {assetMediaType(activeAsset)} / {assetTypeLabels[activeAsset.type]}</span><h2 id="asset-detail-title">{activeAsset.name}</h2></div><button type="button" className="close" aria-label="关闭资产详情" disabled={Boolean(busy)} onClick={() => setActiveAssetId(null)}>×</button></div><div className="asset-detail-body">
        <p className="asset-detail-identity">{activeAsset.identity}</p>
        {projectId && activeAsset.localFiles.length > 0 && <section className="asset-detail-section"><div className="asset-description-heading"><strong>已绑定参考图</strong><span>可在此更换或删除，所有操作保留历史</span></div><div className="asset-reference-grid">{activeAsset.localFiles.map((_file, index) => {
          const fileRole = activeAsset.fileRoles[index] ?? (index === 0 ? "主参考" : `参考 ${index + 1}`);
          const replaceBusy = busy === `replace:${activeAsset.id}:${index}`;
          const deleteBusy = busy === `delete:${activeAsset.id}:${index}`;
          return <figure key={`${activeAsset.id}-${index}-${activeAsset.sha256[index] ?? "reference"}`}><img src={api.assetReferenceUrl(projectId, activeAsset.id, index)} alt={`${activeAsset.name} ${fileRole}`} /><figcaption>{fileRole}</figcaption>{editable && <div className="asset-reference-item-actions">{onReplace && <label className={`secondary file-button reference-replace ${replaceBusy || !authorizationConfirmed ? "disabled" : ""}`} title={authorizationConfirmed ? `更换${fileRole}` : "更换图片前请先确认参考图使用权限"}>{replaceBusy ? "更换中…" : "更换"}<input type="file" aria-label={`更换 ${activeAsset.name} ${fileRole}`} accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy) || !authorizationConfirmed} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; void onReplace(activeAsset.id, index, file).then(() => setUploadFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "success", message: `${fileRole}已更换，旧图已进入历史回收目录` } }))).catch((reason) => setUploadFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "error", message: reason instanceof Error ? reason.message : "参考图更换失败" } }))); }} /></label>}{onDelete && <button type="button" className="secondary reference-delete" disabled={Boolean(busy)} aria-label={`删除 ${activeAsset.name} ${fileRole}`} onClick={() => setDeleteTarget({ assetId: activeAsset.id, assetName: activeAsset.name, index, role: fileRole })}>{deleteBusy ? "删除中…" : "删除"}</button>}{onReplace && !authorizationConfirmed && <span className="reference-replace-hint">勾选顶部图片权限后可更换</span>}</div>}</figure>;
        })}</div></section>}
        <section className="asset-detail-section"><div className="asset-description-heading"><strong>人物／场景详细设定</strong><span>这些内容会进入参考图提示词</span></div><dl>
          <div><dt>设计依据</dt><dd>{activeAsset.designBasis === "creative-proposal" ? "原创设计提案" : activeAsset.designBasis === "reference-guided" ? "参考图锁定" : "剧本／原文依据"}</dd></div>
          <div><dt>视觉摘要</dt><dd>{activeAsset.designSummary || "未提供"}</dd></div>
          <div><dt>完整外观</dt><dd>{activeAsset.appearance}</dd></div>
          <div><dt>固定识别特征</dt><dd>{activeAsset.distinctiveFeatures.join("；") || "未提供"}</dd></div>
          <div><dt>禁止漂移</dt><dd>{activeAsset.negativeConstraints.join("；") || "未提供"}</dd></div>
          <div><dt>连续性</dt><dd>{activeAsset.continuityRules.join("；") || "无"}</dd></div>
          <div className={activeAsset.unknowns.length ? "unresolved" : ""}><dt>未知项</dt><dd>{activeAsset.unknowns.join("；") || "无"}</dd></div>
          <div><dt>镜头引用</dt><dd>{activeAsset.referencedBy.join("、") || "尚未引用"}</dd></div>
        </dl></section>
        {editable && visualAssetTypesForUi.has(activeAsset.type) && <div className="asset-reference-workbench">
          <div className="asset-reference-actions"><select aria-label={`${activeAsset.name}参考图类型`} value={activeRole} onChange={(event) => setRoles((current) => ({ ...current, [activeAsset.id]: event.target.value as AssetReferenceRole }))}><option>主参考</option><option>正面</option><option>侧面</option><option>背面</option><option>表情</option><option>服装</option><option>其他</option></select>{onGeneratePrompt && <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => { setPromptFeedback((current) => { const next = { ...current }; delete next[activeAsset.id]; return next; }); void onGeneratePrompt(activeAsset.id, activeRole).then((result) => { setImageProvider(result.imageProvider); setPromptFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "success", message: `${activeRole}提示词 V${String(result.prompt.version).padStart(3, "0")} 已生成` } })); }).catch((reason) => setPromptFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "error", message: reason instanceof Error ? reason.message : "提示词生成失败" } }))); }}>{busy === `prompt:${activeAsset.id}` ? "Codex 生成中…" : activeLatestPrompt ? "重新生成提示词" : "Codex 生成提示词"}</button>}</div>
          {activeLatestPrompt && <div className="asset-prompt-panel"><div><strong>{activeLatestPrompt.role}参考图提示词 · V{String(activeLatestPrompt.version).padStart(3, "0")}</strong><span>本地 Codex · {new Date(activeLatestPrompt.createdAt).toLocaleString("zh-CN")}</span></div><div className="asset-prompt-field"><span>中文提示词</span><div className="asset-prompt-text">{activeLatestPrompt.promptZh}</div></div>{activeIncludeEnglish && <div className="asset-prompt-field"><span>英文提示词</span><div className="asset-prompt-text">{activeLatestPrompt.promptEn}</div></div>}<div className="asset-prompt-field"><span>负面提示词</span><div className="asset-prompt-text">{activeLatestPrompt.negativePrompt}</div></div><div className="asset-prompt-actions"><label className="prompt-english-option"><input type="checkbox" aria-label={`复制 ${activeAsset.name} 时附带英文`} checked={activeIncludeEnglish} onChange={(event) => setIncludeEnglishByAsset((current) => ({ ...current, [activeAsset.id]: event.target.checked }))} /><span>附带英文</span></label><button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(referencePromptClipboardText(activeLatestPrompt, activeIncludeEnglish)).then(() => setPromptFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "success", message: activeIncludeEnglish ? "中文、英文与负面提示词已复制" : "中文与负面提示词已复制" } }))).catch(() => setPromptFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "error", message: "复制失败，请检查剪贴板权限" } })))}>{activeIncludeEnglish ? "复制中文＋英文＋负面" : "复制中文＋负面"}</button>{onGenerateImage && <button type="button" className="primary" disabled={Boolean(busy) || !imageProvider?.enabled} title={imageProvider?.enabled ? "使用已配置的图像 Provider 生成并绑定" : imageProvider?.reason ?? "图像生成 API 尚未配置"} onClick={() => void onGenerateImage(activeAsset.id, activeLatestPrompt.id).catch((reason) => setPromptFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "error", message: reason instanceof Error ? reason.message : "参考图生成失败" } })))}>{busy === `image:${activeAsset.id}` ? "正在生成图片…" : imageProvider?.enabled ? "一键生成并绑定参考图" : "生成参考图（API 待接入）"}</button>}</div></div>}
          {promptFeedback[activeAsset.id] && <p className={`asset-upload-feedback ${promptFeedback[activeAsset.id].kind}`} role={promptFeedback[activeAsset.id].kind === "error" ? "alert" : "status"}>{promptFeedback[activeAsset.id].kind === "success" ? "✓ " : "! "}{promptFeedback[activeAsset.id].message}</p>}
          {onUpload && <><div className="asset-upload-divider"><span>或上传已有图片</span></div><div className="asset-reference-actions upload-only"><span className="asset-upload-role">保存为：{activeRole}</span><label className={`secondary file-button ${busy === `upload:${activeAsset.id}` || !authorizationConfirmed ? "disabled" : ""}`} title={authorizationConfirmed ? undefined : "请先确认参考图使用权限"}>{busy === `upload:${activeAsset.id}` ? "正在保存…" : authorizationConfirmed ? activeAsset.localFiles.length ? `＋ 继续上传（已存 ${activeAsset.localFiles.length} 张）` : "＋ 上传已有参考图" : "上传前请确认权限"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy) || !authorizationConfirmed} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; setUploadFeedback((current) => { const next = { ...current }; delete next[activeAsset.id]; return next; }); void onUpload(activeAsset.id, file, activeRole).then(() => setUploadFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "success", message: `${file.name} 已保存并绑定为${activeRole}` } }))).catch((reason) => setUploadFeedback((current) => ({ ...current, [activeAsset.id]: { kind: "error", message: reason instanceof Error ? reason.message : "参考图上传失败" } }))); }} /></label></div>{uploadFeedback[activeAsset.id] && <p className={`asset-upload-feedback ${uploadFeedback[activeAsset.id].kind}`} role={uploadFeedback[activeAsset.id].kind === "error" ? "alert" : "status"}>{uploadFeedback[activeAsset.id].kind === "success" ? "✓ " : "! "}{uploadFeedback[activeAsset.id].message}</p>}</>}
        </div>}
      </div></div></div>}
      {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDeleteTarget(null)}><div ref={deleteDialogRef} tabIndex={-1} className="project-modal asset-reference-delete-modal" role="dialog" aria-modal="true" aria-labelledby="asset-reference-delete-title"><div className="modal-head"><div><span className="eyebrow">REMOVE REFERENCE</span><h2 id="asset-reference-delete-title">删除这张参考图？</h2></div><button type="button" className="close" aria-label="关闭删除确认" onClick={() => setDeleteTarget(null)}>×</button></div><div className="asset-reference-delete-body"><strong>{deleteTarget.assetId} · {deleteTarget.assetName}</strong><p>将解除“{deleteTarget.role}”图片与当前资产的绑定。原文件会移入项目内的历史回收目录，不会永久销毁。</p></div><div className="modal-footer"><button type="button" className="secondary" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="danger secondary" onClick={() => { const target = deleteTarget; setDeleteTarget(null); if (!onDelete) return; void onDelete(target.assetId, target.index).then(() => setUploadFeedback((current) => ({ ...current, [target.assetId]: { kind: "success", message: `${target.role}已删除，原文件保留在历史回收目录` } }))).catch((reason) => setUploadFeedback((current) => ({ ...current, [target.assetId]: { kind: "error", message: reason instanceof Error ? reason.message : "参考图删除失败" } }))); }}>确认删除</button></div></div></div>}
    </div>
  );
}

function ShotEditor({ shots, activeShotId, draft, busy, onSelect, onChange, onSave }: {
  shots: ShotSpec[];
  activeShotId: string | null;
  draft: ShotSpec | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onChange: (shot: ShotSpec) => void;
  onSave: () => void;
}) {
  if (!draft) return <div className="structured-empty"><strong>尚未生成 ShotSpec</strong><p>批准资产定义后，使用导演 Skill 创建连续时间码镜头。</p></div>;
  const change = <K extends keyof ShotSpec,>(key: K, value: ShotSpec[K]) => onChange({ ...draft, [key]: value });
  return (
    <div className="shot-editor">
      <div className="shot-timeline">{shots.map((shot) => <button className={shot.id === activeShotId ? "active" : ""} key={shot.id} disabled={busy} onClick={() => onSelect(shot.id)}><b>{shot.id}</b><span>{shot.startTimeSec}–{shot.endTimeSec}s</span></button>)}</div>
      <div className="shot-editor-head"><div><span>{draft.id}</span><strong>{draft.startTimeSec.toFixed(2)}–{draft.endTimeSec.toFixed(2)} 秒</strong></div><b>{draft.status}</b></div>
      <div className="shot-form-grid">
        <label><span>镜头目的</span><input disabled={busy} value={draft.purpose} onChange={(event) => change("purpose", event.target.value)} /></label>
        <label><span>景别</span><input disabled={busy} value={draft.shotSize} onChange={(event) => change("shotSize", event.target.value)} /></label>
        <label><span>机位</span><input disabled={busy} value={draft.camera.position} onChange={(event) => change("camera", { ...draft.camera, position: event.target.value })} /></label>
        <label><span>运镜</span><input disabled={busy} value={draft.camera.movement} onChange={(event) => change("camera", { ...draft.camera, movement: event.target.value })} /></label>
        <label className="full"><span>动作与表演</span><textarea disabled={busy} value={draft.action} onChange={(event) => change("action", event.target.value)} /></label>
        <label className="full"><span>起始状态</span><textarea disabled={busy} value={draft.startState} onChange={(event) => change("startState", event.target.value)} /></label>
        <label className="full"><span>结束状态</span><textarea disabled={busy} value={draft.endState} onChange={(event) => change("endState", event.target.value)} /></label>
      </div>
      <div className="shot-reference-strip"><span>资产引用</span><code>{[...draft.characterIds, draft.sceneId, ...draft.propIds, ...draft.styleIds].join(" · ")}</code></div>
      <button className="primary shot-save" disabled={busy} onClick={onSave}>{busy ? "正在保存…" : "保存为新导演脚本版本"}</button>
    </div>
  );
}

function Metric({ icon, label, value, detail, accent }: { icon: string; label: string; value: string; detail: string; accent: string }) {
  return <div className={`metric ${accent}`}><span className="metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></div>;
}

function ContextChecks({ project, health }: { project: Project; health: Health | null }) {
  const h3Skill = health?.textSkills.find((skill) => skill.name === "h3-prompt-writing");
  const checks = [
    ["本地服务", health?.ok ? "正常" : "连接中", health?.ok],
    ["原始文件", "已锁定", true],
    ["付费 API", "已关闭", true],
    ["文字模型", health?.textModel ?? "检测中", Boolean(health?.textModel && health.textModel !== "unreported")],
    ["文字 Skill", health?.skillDrivenTextGeneration ? `${health.textSkills.length} 个已校验` : health?.skillLoadError ?? "未启用", health?.skillDrivenTextGeneration],
    ["H3 Skill", h3Skill ? h3Skill.version : "未载入", Boolean(h3Skill)],
    ["媒体粗剪", health?.mediaTools.roughCutReady ? "已就绪" : health ? `缺 ${missingRoughCutCapabilities(health.mediaTools).join("/")}` : "检测中", Boolean(health?.mediaTools.roughCutReady)],
  ] as const;
  return (
    <>
      <div className="stage-status"><small>当前状态</small><strong>{stageLabels[project.currentStage]}</strong><span>项目可在重启后恢复</span></div>
      <div className="check-list">
        {checks.map(([name, value, ok]) => <div key={name}><span><i className={ok ? "ok" : "warn"} />{name}</span><b>{value}</b></div>)}
      </div>
      <div className="context-note"><span>审批原则</span><p>上游文件一旦修改，原审批自动失效；历史记录保留，不覆盖。</p></div>
      <div className="path-card"><small>项目主库</small><code title={project.projectDir}>{project.projectDir}</code></div>
    </>
  );
}

function ArchiveProjectModal({ project, onClose, onArchive }: {
  project: Project;
  onClose: () => void;
  onArchive: (projectId: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose, saving);
  async function confirm() {
    setSaving(true);
    setError(null);
    try { await onArchive(project.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除项目失败"); setSaving(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className="project-modal archive-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="archive-project-title">
        <div className="modal-head"><div><span className="eyebrow">RECOVERABLE DELETE</span><h2 id="archive-project-title">删除项目“{project.title}”</h2></div><button type="button" className="close" aria-label="关闭对话框" disabled={saving} onClick={onClose}>×</button></div>
        <div className="archive-confirm-body">
          <div className="archive-symbol">⌫</div>
          <div><strong>项目将从当前工作区移除</strong><p>项目目录、原始内容、资产、镜头、生成记录和全部历史版本都会原样保留。之后可从顶部“已归档”恢复。</p></div>
          <dl><div><dt>当前阶段</dt><dd>{stageLabels[project.currentStage]}</dd></div><div><dt>项目目录</dt><dd title={project.projectDir}>{project.projectDir}</dd></div><div><dt>永久删除</dt><dd>否</dd></div></dl>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-footer"><button type="button" className="secondary" data-dialog-initial-focus disabled={saving} onClick={onClose}>取消</button><button type="button" className="danger-action" disabled={saving} onClick={() => void confirm()}>{saving ? "正在移入归档…" : "确认删除（可恢复）"}</button></div>
      </div>
    </div>
  );
}

function ArchivedProjectsModal({ projects, loading, onClose, onRestore }: {
  projects: Project[];
  loading: boolean;
  onClose: () => void;
  onRestore: (projectId: string) => Promise<void>;
}) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose, Boolean(restoringId));
  async function restore(projectId: string) {
    setRestoringId(projectId);
    setError(null);
    try { await onRestore(projectId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "恢复项目失败"); setRestoringId(null); }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => !restoringId && event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className="project-modal archive-manager-modal" role="dialog" aria-modal="true" aria-labelledby="archived-projects-title">
        <div className="modal-head"><div><span className="eyebrow">PROJECT ARCHIVE</span><h2 id="archived-projects-title">已归档项目</h2></div><button type="button" className="close" aria-label="关闭对话框" disabled={Boolean(restoringId)} onClick={onClose}>×</button></div>
        <div className="archive-list">
          {loading ? <div className="archive-empty"><div className="loader mini" /><span>正在读取归档…</span></div> : projects.length ? projects.map((project) => <article key={project.id}><div><strong>{project.title}</strong><span>{stageLabels[project.currentStage]} · 归档于 {project.archivedAt ? new Date(project.archivedAt).toLocaleString("zh-CN") : "未知时间"}</span><code>{project.projectDir}</code></div><button className="secondary" disabled={Boolean(restoringId)} onClick={() => void restore(project.id)}>{restoringId === project.id ? "正在恢复…" : "恢复项目"}</button></article>) : <div className="archive-empty"><strong>暂无归档项目</strong><span>删除的项目会保留在这里，需要时可恢复；系统不会自动清理。</span></div>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-footer"><button type="button" className="secondary" disabled={Boolean(restoringId)} onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}

function CreateProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: CreateProjectInput) => Promise<void> }) {
  const [form, setForm] = useState<CreateProjectInput>(() => {
    if (typeof window === "undefined") return { ...emptyForm };
    try { return parseCreateProjectDraft(window.sessionStorage.getItem(createProjectDraftStorageKey)) ?? { ...emptyForm }; }
    catch { return { ...emptyForm }; }
  });
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLFormElement>(true, onClose, saving);
  const formRef = useRef(form);
  const createdRef = useRef(false);
  formRef.current = form;

  function persistDraft(value: CreateProjectInput) {
    if (typeof window === "undefined") return;
    try {
      if (hasMeaningfulCreateProjectDraft(value, emptyForm)) {
        window.sessionStorage.setItem(createProjectDraftStorageKey, serializeCreateProjectDraft(value));
      } else {
        window.sessionStorage.removeItem(createProjectDraftStorageKey);
      }
    } catch {
      // The live form remains intact even if this browser blocks session storage.
    }
  }

  useEffect(() => {
    persistDraft(form);
  }, [form]);

  useEffect(() => () => {
    if (!createdRef.current) persistDraft(formRef.current);
  }, []);

  function clearDraft() {
    if (!window.confirm("确定清空当前新建项目表单吗？此操作只清空尚未创建的草稿。")) return;
    try { window.sessionStorage.removeItem(createProjectDraftStorageKey); } catch { /* Keep the in-memory reset authoritative. */ }
    const reset = { ...emptyForm };
    formRef.current = reset;
    setForm(reset);
    setStep("edit");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "edit") {
      setStep("confirm");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(form);
      createdRef.current = true;
      try { window.sessionStorage.removeItem(createProjectDraftStorageKey); } catch { /* The project was still created successfully. */ }
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form ref={dialogRef} tabIndex={-1} className="project-modal" role="dialog" aria-modal="true" aria-labelledby="create-project-title" onSubmit={submit}>
        <div className="modal-head"><div><span className="eyebrow">NEW PRODUCTION</span><h2 id="create-project-title">{step === "edit" ? "创建本地视频项目" : "确认接入路线"}</h2></div><button type="button" className="close" aria-label="关闭并保留草稿" disabled={saving} onClick={onClose}>×</button></div>
        {step === "edit" ? (
          <div className="form-grid">
            <label className="full"><span>项目名称</span><input autoFocus data-dialog-initial-focus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例如：雨夜来客" /></label>
            <label><span>输入类型</span><select value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value as SourceType })}>{Object.entries(sourceLabels).map(([value, label]) => <option value={value} key={value} disabled={value === "shooting-script" || value === "storyboard"}>{label}{value === "shooting-script" || value === "storyboard" ? "（待开放结构化导入）" : ""}</option>)}</select></label>
            <label><span>目标时长（秒，最低 5 秒）</span><input required min="5" step="1" max="21600" type="number" value={form.targetDurationSec} onChange={(e) => setForm({ ...form, targetDurationSec: Number(e.target.value) })} /></label>
            <label><span>画幅</span><select value={form.aspectRatio} onChange={(e) => { const aspectRatio = e.target.value; const options = outputResolutionOptions[aspectRatio]; setForm({ ...form, aspectRatio, resolution: options.includes(form.resolution) ? form.resolution : options[0] }); }}><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
            <label><span>成片输出规格（最低 480p）</span><select value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })}>{outputResolutionOptions[form.aspectRatio].map((resolution) => <option key={resolution}>{resolution}</option>)}</select></label>
            <label><span>视频类型</span><input value={form.videoType} onChange={(e) => setForm({ ...form, videoType: e.target.value })} /></label>
            <label><span>发布平台</span><input value={form.releasePlatform} onChange={(e) => setForm({ ...form, releasePlatform: e.target.value })} placeholder="可选" /></label>
            <label className="full"><span>视觉风格</span><input value={form.visualStyle} onChange={(e) => setForm({ ...form, visualStyle: e.target.value })} placeholder="例如：冷灰电影感，克制手持摄影" /></label>
            <label className="full"><span>原始内容</span><textarea required value={form.sourceText} onChange={(e) => setForm({ ...form, sourceText: e.target.value })} placeholder="粘贴原始故事或已有剧本内容…" /></label>
            <label className="check full"><input type="checkbox" checked={form.allowStorySuggestions} onChange={(e) => setForm({ ...form, allowStorySuggestions: e.target.checked })} /><span>允许系统提出剧情修改建议（不会自动改写）</span></label>
          </div>
        ) : (
          <div className="confirm-route">
            <div className="route-icon">{form.sourceType === "story" ? "01" : form.sourceType === "screenplay" ? "03" : form.sourceType === "shooting-script" ? "05" : "06"}</div>
            <div><span className="eyebrow">DETECTED ENTRY</span><h3>{sourceLabels[form.sourceType]}</h3><p>系统将从对应阶段继续，不重复已经完成的工作。原始内容保存为不可变 V001，后续每次批准都会记录文件哈希。</p></div>
            <dl><div><dt>项目</dt><dd>{form.title}</dd></div><div><dt>成片目标</dt><dd>{form.targetDurationSec} 秒 · {form.aspectRatio} · {form.resolution}</dd></div><div><dt>自动付费</dt><dd>关闭</dd></div></dl>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {step === "edit" && <p className="create-draft-note" role="status">表单已自动保存为当前浏览器会话草稿；点击弹窗周围空白不会关闭或清空内容。</p>}
        <div className="modal-footer">{step === "edit" && <button type="button" className="secondary draft-clear" disabled={saving || !hasMeaningfulCreateProjectDraft(form, emptyForm)} onClick={clearDraft}>清空草稿</button>}<button type="button" className="secondary" disabled={saving} onClick={() => step === "confirm" ? setStep("edit") : onClose()}>{step === "confirm" ? "返回修改" : "暂存并关闭"}</button><button className="primary" disabled={saving}>{saving ? "正在创建…" : step === "edit" ? "识别接入路线 →" : "确认并创建项目"}</button></div>
      </form>
    </div>
  );
}
