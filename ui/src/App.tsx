import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { reviewDimensions, type Artifact, type ArtifactType, type Asset, type AssetDesignMode, type CreateProjectInput, type GenerationCenter, type Health, type Project, type ProjectStage, type QualityCenter, type QualityDecision, type QualityReviewInput, type ReviewDimensionStatus, type ShotSpec, type SkillProvenance, type SourceType } from "./types";

const stageGroups = [
  { label: "输入内容", stages: ["SOURCE_IMPORTED"] },
  { label: "剧情大纲", stages: ["OUTLINE_REVIEW", "OUTLINE_APPROVED"] },
  { label: "影视剧本", stages: ["SCREENPLAY_REVIEW", "SCREENPLAY_APPROVED"] },
  { label: "资产定义", stages: ["ASSET_BIBLE_REVIEW", "ASSET_BIBLE_APPROVED", "ASSETS_LOCKED"] },
  { label: "导演脚本", stages: ["SHOOTING_SCRIPT_REVIEW", "SHOOTING_SCRIPT_APPROVED"] },
  { label: "分镜设计", stages: ["STORYBOARD_REVIEW", "STORYBOARD_APPROVED"] },
  { label: "视频生成", stages: ["READY_FOR_GENERATION", "GENERATING"] },
  { label: "质量审核", stages: ["GENERATION_REVIEW"] },
  { label: "剪辑导出", stages: ["EDITING", "FINAL_REVIEW", "DELIVERED"] },
] satisfies Array<{ label: string; stages: ProjectStage[] }>;

const allStages = stageGroups.flatMap((group) => group.stages);

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

function Icon({ children }: { children: ReactNode }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<"dashboard" | "stage" | "assets" | "generation" | "quality" | "delivery">("dashboard");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );

  useEffect(() => {
    void Promise.all([api.listProjects(), api.health()])
      .then(([projectResult, healthResult]) => {
        setProjects(projectResult.projects);
        setHealth(healthResult);
        if (projectResult.projects[0]) setSelectedId(projectResult.projects[0].id);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(input: CreateProjectInput) {
    const { project } = await api.createProject(input);
    setProjects((current) => [project, ...current]);
    setSelectedId(project.id);
    setModalOpen(false);
    setView("dashboard");
  }

  function updateProject(project: Project) {
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { setSelectedId(projects[0]?.id ?? null); setView("dashboard"); }}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>AI VIDEO</strong><small>STUDIO / LOCAL</small></span>
        </button>

        <nav className="main-nav" aria-label="主导航">
          <button className={view === "dashboard" || view === "stage" ? "active" : ""} onClick={() => setView("dashboard")}>创作流程</button>
          <button className={view === "assets" ? "active" : ""} disabled={!selected} onClick={() => setView("assets")}>素材库</button>
          <button className={view === "generation" ? "active" : ""} disabled={!selected} onClick={() => setView("generation")}>生成中心</button>
          <button className={view === "quality" ? "active" : ""} disabled={!selected} onClick={() => setView("quality")}>质量审核</button>
          <button className={view === "delivery" ? "active" : ""} disabled={!selected} onClick={() => setView("delivery")}>成片交付</button>
        </nav>

        <div className="top-actions">
          <span className={`local-state ${health?.ok ? "online" : "offline"}`}>
            <i />{health?.ok ? "本地服务在线" : "正在连接"}
          </span>
          <button className="primary compact" onClick={() => setModalOpen(true)}>＋ 新建项目</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}<button onClick={() => setError(null)}>关闭</button></div>}

      <div className={`workspace ${view !== "dashboard" ? "stage-mode" : ""}`}>
        <aside className="stage-sidebar">
          <div className="sidebar-heading">
            <span>PRODUCTION FLOW</span>
            <small>{selected ? "01 / 09" : "未选择项目"}</small>
          </div>
          <div className="stage-list">
            {stageGroups.map((group, index) => {
              const currentIndex = selected ? allStages.indexOf(selected.currentStage) : -1;
              const groupStart = allStages.indexOf(group.stages[0]);
              const groupEnd = allStages.indexOf(group.stages[group.stages.length - 1]);
              const state = currentIndex > groupEnd ? "done" : currentIndex >= groupStart ? "current" : "future";
              return (
                <button className={`stage-item ${state}`} key={group.label}>
                  <span className="stage-number">{String(index + 1).padStart(2, "0")}</span>
                  <span><strong>{group.label}</strong><small>{state === "done" ? "已完成" : state === "current" ? "当前阶段" : "待开始"}</small></span>
                  <b>{state === "done" ? "✓" : state === "current" ? "→" : "·"}</b>
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
          ) : selected && view === "stage" ? (
            <StageWorkspace project={selected} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "assets" ? (
            <AssetLibraryWorkspace project={selected} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "generation" ? (
            <GenerationCenterWorkspace project={selected} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "quality" ? (
            <QualityReviewWorkspace project={selected} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected && view === "delivery" ? (
            <DeliveryWorkspace project={selected} onBack={() => setView("dashboard")} onProjectUpdate={updateProject} onError={setError} />
          ) : selected ? (
            <ProjectDashboard project={selected} projects={projects} onSelect={(id) => { setSelectedId(id); setView("dashboard"); }} onCreate={() => setModalOpen(true)} onOpenStage={() => setView("stage")} onOpenGeneration={() => setView("generation")} />
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

function ProjectDashboard({ project, projects, onSelect, onCreate, onOpenStage, onOpenGeneration }: {
  project: Project;
  projects: Project[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenStage: () => void;
  onOpenGeneration: () => void;
}) {
  const [assetCount, setAssetCount] = useState(0);
  const [shotCount, setShotCount] = useState(0);
  useEffect(() => {
    void Promise.all([api.listAssets(project.id), api.listShots(project.id)]).then(([assetResult, shotResult]) => {
      setAssetCount(assetResult.assets.length);
      setShotCount(shotResult.shots.length);
    });
  }, [project.id, project.updatedAt]);
  const currentPosition = allStages.indexOf(project.currentStage);
  const progress = Math.max(4, Math.round(((currentPosition + 1) / allStages.length) * 100));
  const focusTitle = project.currentStage === "SOURCE_IMPORTED"
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
              : "继续当前人工审核";
  const focusBody = project.currentStage === "SOURCE_IMPORTED"
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
              : "当前版本等待你的明确批准或驳回；系统不会自动越过人工门禁。";
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
            {projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <button className="secondary" onClick={onCreate}>新项目</button>
        </div>
      </div>

      <div className="progress-card">
        <div className="progress-top"><span>总流程进度</span><strong>{progress}%</strong></div>
        <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
        <div className="progress-meta"><span>当前：{stageLabels[project.currentStage]}</span><span>本地自动保存</span></div>
      </div>

      <div className="metric-grid">
        <Metric icon="⌁" label="待审核" value={project.currentStage.endsWith("_REVIEW") ? "1" : "0"} detail="阶段门禁" accent="violet" />
        <Metric icon="◫" label="素材资产" value={String(assetCount)} detail={assetCount ? "逻辑资产" : "等待资产定义"} accent="cyan" />
        <Metric icon="▶" label="镜头计划" value={String(shotCount)} detail={shotCount ? "结构化 ShotSpec" : "等待导演脚本"} accent="amber" />
        <Metric icon="✓" label="交付版本" value="0" detail="历史永不覆盖" accent="green" />
      </div>

      <div className="content-grid">
        <article className="focus-card">
          <div className="card-kicker"><span>当前工作</span><small>{stageLabels[project.currentStage]}</small></div>
          <h2>{focusTitle}</h2>
          <p>{focusBody}</p>
          <div className="focus-actions">
            <button className="primary" onClick={(["STORYBOARD_APPROVED", "ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW", "EDITING", "FINAL_REVIEW", "DELIVERED"] as ProjectStage[]).includes(project.currentStage) ? onOpenGeneration : onOpenStage}>{(["STORYBOARD_APPROVED", "ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW", "EDITING", "FINAL_REVIEW", "DELIVERED"] as ProjectStage[]).includes(project.currentStage) ? "进入生成中心" : "进入当前阶段"} <span>→</span></button>
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
  storyboard: "通常 2–8 分钟（包含连续性检查）",
};

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
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
const nextArtifactByApprovedStage: Partial<Record<ProjectStage, ArtifactType>> = {
  OUTLINE_APPROVED: "screenplay",
  SCREENPLAY_APPROVED: "asset-bible",
  ASSET_BIBLE_APPROVED: "shooting-script",
  SHOOTING_SCRIPT_APPROVED: "storyboard",
};
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

function GenerationCenterWorkspace({ project, onBack, onProjectUpdate, onError }: {
  project: Project;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const [center, setCenter] = useState<GenerationCenter | null>(null);
  const [qualityCenter, setQualityCenter] = useState<QualityCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const [generationResult, qualityResult] = await Promise.all([api.generationCenter(project.id), api.qualityCenter(project.id)]);
    setCenter(generationResult);
    setQualityCenter(qualityResult);
  }

  useEffect(() => {
    setLoading(true);
    void load().catch((reason: Error) => onError(reason.message)).finally(() => setLoading(false));
  }, [project.id, project.updatedAt]);

  async function run(key: string, action: () => Promise<{ project?: Project; [key: string]: unknown }>, message: string) {
    setBusy(key);
    setNotice(null);
    onError(null);
    try {
      const result = await action();
      if (result.project) onProjectUpdate(result.project);
      await load();
      setNotice(message);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function createShotPackage(shotId: string) {
    if (!window.confirm(`即将把 ${shotId} 的已批准内容发送给本地 Codex，使用官方 H3 Skill 生成提示词。不会调用付费视频 API，也不会自动上传。是否继续？`)) return;
    await run(`shot:${shotId}`, () => api.createUpdreamShotPackage(project.id, shotId), `${shotId} 的 H3 / Updream 新版本包已创建。`);
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

  async function scanInbox() {
    setBusy("scan");
    setNotice(null);
    onError(null);
    try {
      const result = await api.scanGenerationInbox(project.id);
      onProjectUpdate(result.project);
      await load();
      const detail = [`导入 ${result.imported.length} 个`, `跳过 ${result.skipped.length} 个`, `错误 ${result.errors.length} 个`].join(" · ");
      setNotice(`收件箱扫描完成：${detail}`);
      if (result.errors.length) onError(result.errors.map((item) => `${item.fileName}：${item.reason}`).join("；"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "扫描失败");
    } finally {
      setBusy(null);
    }
  }

  if (loading || !center || !qualityCenter) return <div className="empty-state"><div className="loader" /><p>正在读取 H3、Updream 与本地媒体工具状态…</p></div>;
  const generationReady = (["STORYBOARD_APPROVED", "ASSETS_LOCKED", "READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage);
  const uploadedAssets = center.assets.filter((asset) => asset.uploadState.updream === "uploaded").length;
  const packageCount = center.shots.reduce((total, item) => total + item.packages.length, 0);
  return (
    <section className="generation-center-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="generation-head">
        <div><span className="eyebrow">MANUAL PROVIDER HANDOFF</span><h1>{project.title} · 生成中心</h1><p>官方 MiniMax H3 Skill 负责提示词；Updream 只生成本地人工投递包。</p></div>
        <div className="generation-metrics"><strong>{uploadedAssets}/{center.assets.length}</strong><span>素材已标记上传</span><strong>{packageCount}</strong><span>镜头包版本</span></div>
      </div>
      {notice && <div className="success-notice">✓ {notice}</div>}
      {!generationReady && <div className="generation-lock"><b>当前尚未到达生成阶段</b><p>先完成并批准资产定义、ShotSpec 与分镜。生成中心可以查看能力，但不会越过审批门禁。</p></div>}
      <div className="provider-capability-card">
        <div><span>H3 CAPABILITY / VERIFIED {new Date(center.capabilities.verifiedAt).toLocaleDateString("zh-CN")}</span><strong>{center.capabilities.model}</strong><p>{center.capabilities.durationMinSec}–{center.capabilities.durationMaxSec} 秒 · {center.capabilities.aspectRatios.join(" / ")} · 默认短边 {center.capabilities.defaultShortSide}px</p></div>
        <div className="provider-skills">{center.skills.map((skill) => <code key={skill.name}>{skill.name}<small>{skill.version} · {skill.sha256.slice(0, 10)}…</small></code>)}</div>
      </div>
      <div className="handoff-step-grid">
        <article className={project.currentStage === "STORYBOARD_APPROVED" ? "active" : center.bootstrap || (["ASSETS_LOCKED", "READY_FOR_GENERATION"] as ProjectStage[]).includes(project.currentStage) ? "done" : ""}><span>01</span><div><strong>锁定批准素材</strong><p>冻结当前资产与 ShotSpec 投递基线。</p></div><button className="secondary" disabled={project.currentStage !== "STORYBOARD_APPROVED" || Boolean(busy)} onClick={() => void run("lock", () => api.lockAssets(project.id), "素材已锁定；现在可以建立 Updream 初始化包。")}>{busy === "lock" ? "锁定中…" : project.currentStage === "STORYBOARD_APPROVED" ? "确认锁定" : (["ASSETS_LOCKED", "READY_FOR_GENERATION"] as ProjectStage[]).includes(project.currentStage) ? "已完成" : "等待分镜批准"}</button></article>
        <article className={project.currentStage === "ASSETS_LOCKED" ? "active" : center.bootstrap ? "done" : ""}><span>02</span><div><strong>创建初始化包</strong><p>汇总素材索引和人工上传清单。</p></div><button className="secondary" disabled={project.currentStage !== "ASSETS_LOCKED" || Boolean(busy)} onClick={() => void run("bootstrap", () => api.createUpdreamBootstrap(project.id), "Updream 初始化包已创建；镜头提示词可以开始编译。")}>{busy === "bootstrap" ? "创建中…" : center.bootstrap ? "已创建" : project.currentStage === "ASSETS_LOCKED" ? "创建本地包" : "等待素材锁定"}</button></article>
        <article className={project.currentStage === "READY_FOR_GENERATION" ? "active" : ""}><span>03</span><div><strong>逐镜头编译</strong><p>每次都新增版本，不覆盖旧包。</p></div><b>{project.currentStage === "READY_FOR_GENERATION" ? "READY" : "WAIT"}</b></article>
      </div>
      <article className={`generation-import-card ${qualityCenter.mediaTools.ffprobeAvailable ? "ready" : "blocked"}`}>
        <div>
          <span>LOCAL GENERATION INBOX</span>
          <strong>生成视频收件箱</strong>
          <p>把文件命名为 S003_V01.mp4 后放入下方目录。系统复制归档，绝不覆盖原件。</p>
          <code>{qualityCenter.inboxPath}</code>
        </div>
        <div className="import-tool-state">
          <b>{qualityCenter.mediaTools.ffprobeAvailable ? "FFPROBE READY" : "FFPROBE MISSING"}</b>
          <small>{qualityCenter.generations.length} 个已导入版本</small>
          <button className="primary" disabled={!(["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage) || !qualityCenter.mediaTools.ffprobeAvailable || Boolean(busy)} onClick={() => void scanInbox()}>{busy === "scan" ? "正在校验…" : "立即扫描收件箱"}</button>
        </div>
      </article>
      {!qualityCenter.mediaTools.ffprobeAvailable && <div className="generation-lock"><b>当前机器未检测到 ffprobe</b><p>导入按钮已真实拦截。安装 FFmpeg，或配置 AI_VIDEO_STUDIO_FFPROBE_PATH 后再扫描；系统不会把未验证文件标成成功。</p></div>}
      {qualityCenter.generations.length > 0 && <div className="generation-version-strip">{qualityCenter.generations.map((generation) => <span key={generation.id}><code>{generation.shotId} V{String(generation.generationVersion).padStart(3, "0")}</code><b>{generation.status}</b><small>{generation.media.width}×{generation.media.height} · {generation.media.durationSec.toFixed(2)}s</small></span>)}</div>}
      <div className="generation-columns">
        <article className="generation-panel asset-upload-panel">
          <header><div><span>UPDREAM ASSETS</span><strong>素材上传登记</strong></div><small>只记录你的人工操作</small></header>
          {!center.assets.length ? <p className="empty-copy">尚无资产。</p> : center.assets.map((asset) => {
            const uploaded = asset.uploadState.updream === "uploaded";
            return <div className="upload-row" key={asset.id}><div><code>{asset.id}</code><strong>{asset.name}</strong><small>{asset.localFiles.length ? `${asset.localFiles.length} 个本地文件` : "仅逻辑定义"}</small></div><button className={uploaded ? "uploaded" : ""} disabled={!center.bootstrap || Boolean(busy)} onClick={() => void run(`asset:${asset.id}`, () => api.setAssetUploadState(project.id, asset.id, uploaded ? "not-uploaded" : "uploaded"), `${asset.id} 已标记为${uploaded ? "未上传" : "已上传"}。`)}>{uploaded ? "✓ 已上传" : "标记已上传"}</button></div>;
          })}
          {center.bootstrap && <button className="path-copy secondary" onClick={() => void navigator.clipboard.writeText(center.bootstrap?.path ?? "")}>复制初始化包路径</button>}
        </article>
        <article className="generation-panel shot-package-panel">
          <header><div><span>H3 SHOT PACKAGES</span><strong>逐镜头提示词与投递包</strong></div><small>人工提交 / 0 自动付费</small></header>
          {!center.shots.length ? <p className="empty-copy">尚无已批准 ShotSpec。</p> : center.shots.map(({ shot, preflight, packages }) => {
            const latest = packages[0] ?? null;
            return <section className={`generation-shot ${preflight.passed ? "ready" : "blocked"}`} key={shot.id}>
              <div className="generation-shot-head"><div><code>{shot.id}</code><strong>{shot.purpose}</strong><small>{shot.durationSec}s · {preflight.mode} · {preflight.references.length} 个本地引用</small></div><b>{preflight.passed ? "PREFLIGHT OK" : "BLOCKED"}</b></div>
              {preflight.errors.map((error) => <p className="preflight-error" key={error}>{error}</p>)}
              {preflight.warnings.slice(0, 2).map((warning) => <p className="preflight-warning" key={warning}>{warning}</p>)}
              <div className="package-actions"><button className="primary" disabled={!(["READY_FOR_GENERATION", "GENERATING"] as ProjectStage[]).includes(project.currentStage) || !preflight.passed || Boolean(busy)} onClick={() => void createShotPackage(shot.id)}>{busy === `shot:${shot.id}` ? "H3 Skill 正在编译…" : latest ? "生成新版本" : "生成 H3 投递包"}</button>{latest && <><button className="secondary" disabled={Boolean(busy)} onClick={() => void copyPrompt(shot.id, latest.version)}>复制 V{String(latest.version).padStart(3, "0")} 提示词</button><button className={latest.uploadState === "uploaded" ? "package-uploaded" : "secondary"} disabled={Boolean(busy)} onClick={() => void run(`package:${shot.id}`, () => api.setPackageUploadState(project.id, shot.id, latest.version, latest.uploadState === "uploaded" ? "not-uploaded" : "uploaded"), `${shot.id} V${String(latest.version).padStart(3, "0")} 投递状态已更新。`)}>{latest.uploadState === "uploaded" ? "✓ 已人工投递" : "标记已投递"}</button></>}</div>
              {latest && <code className="package-path" title={latest.path}>{latest.path}</code>}
            </section>;
          })}
        </article>
      </div>
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
  "conditional-pass": "有条件通过",
  "retry-same-model": "同模型重试",
  "revise-prompt-retry": "修改提示词后重试",
  "switch-model": "更换模型",
  "manual-fix": "人工修复 / 暂不决策",
};

function createEmptyQualityReview(): QualityReviewInput {
  return {
    dimensions: reviewDimensions.map((dimension) => ({
      dimension,
      status: "not-reviewed" as ReviewDimensionStatus,
      note: "待人工填写",
      evidence: "尚未检查",
    })),
    decision: "manual-fix",
    summary: "等待人工观看视频后填写结论",
    conditions: [],
    retryInstructions: [],
    unverifiedClaims: [],
  };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function QualityReviewWorkspace({ project, onBack, onProjectUpdate, onError }: {
  project: Project;
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
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const result = await api.qualityCenter(project.id);
    setCenter(result);
    setSelectedJobId((current) => result.generations.some((item) => item.id === current)
      ? current
      : result.generations.find((item) => item.status === "review")?.id ?? result.generations[0]?.id ?? "");
  }

  useEffect(() => {
    void load().catch((reason: Error) => onError(reason.message));
  }, [project.id, project.updatedAt]);

  const generation = center?.generations.find((item) => item.id === selectedJobId) ?? null;
  const shot = center?.shots.find((item) => item.id === generation?.shotId) ?? null;
  const reviewHistory = center?.reviews.filter((item) => item.jobId === selectedJobId) ?? [];
  const canRender = Boolean(center?.shots.length) && Boolean(center?.shots.every((item) =>
    center.generations.some((generationItem) => generationItem.shotId === item.id && generationItem.status === "accepted")));

  function updateDimension(index: number, field: "status" | "note" | "evidence", value: string) {
    setForm((current) => ({
      ...current,
      dimensions: current.dimensions.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item),
    }));
  }

  async function submitReview() {
    if (!generation) return;
    setBusy("review");
    setNotice(null);
    onError(null);
    try {
      const input: QualityReviewInput = {
        ...form,
        conditions: splitLines(conditionsText),
        retryInstructions: splitLines(retryText),
        unverifiedClaims: splitLines(unverifiedText),
      };
      const result = await api.reviewGeneration(project.id, generation.id, input);
      onProjectUpdate(result.project);
      await load();
      setForm(createEmptyQualityReview());
      setConditionsText("");
      setRetryText("");
      setUnverifiedText("");
      setNotice(`${generation.shotId} V${String(generation.generationVersion).padStart(3, "0")} 的质检记录已保存，原记录未被覆盖。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "质检提交失败");
    } finally {
      setBusy(null);
    }
  }

  async function renderRoughCut() {
    if (!window.confirm("将使用全部已通过镜头创建一个新的本地粗剪版本，不覆盖旧版本。是否继续？")) return;
    setBusy("render");
    setNotice(null);
    onError(null);
    try {
      const result = await api.renderRoughCut(project.id);
      onProjectUpdate(result.project);
      await load();
      setNotice(`粗剪 V${String(result.render.version).padStart(3, "0")} 已生成并进入成片终审。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "粗剪失败");
    } finally {
      setBusy(null);
    }
  }

  if (!center) return <div className="empty-state"><div className="loader" /><p>正在读取生成视频与质检历史…</p></div>;
  return (
    <section className="quality-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="quality-head">
        <div><span className="eyebrow">HUMAN QUALITY GATE</span><h1>{project.title} · 九维质量审核</h1><p>ffprobe 只记录媒体事实；人物、动作、镜头和声音结论必须由你实际观看后填写。</p></div>
        <div className="quality-skill"><span>ACTIVE SKILL</span><strong>{center.skill.name}</strong><code>{center.skill.version} · {center.skill.sha256.slice(0, 12)}…</code></div>
      </div>
      {notice && <div className="success-notice">✓ {notice}</div>}
      {!center.generations.length ? (
        <div className="quality-empty"><strong>还没有可审核的生成视频</strong><p>先在生成中心把 S003_V01.mp4 放入收件箱并完成扫描导入。</p><code>{center.inboxPath}</code></div>
      ) : (
        <>
          <div className="quality-toolbar">
            <label><span>生成版本</span><select value={selectedJobId} onChange={(event) => { setSelectedJobId(event.target.value); setForm(createEmptyQualityReview()); }}>
              {center.generations.map((item) => <option key={item.id} value={item.id}>{item.shotId} · V{String(item.generationVersion).padStart(3, "0")} · {item.status}</option>)}
            </select></label>
            <div><b>{generation?.status.toUpperCase()}</b><span>{generation?.media.width}×{generation?.media.height} · {generation?.media.durationSec.toFixed(3)}s · {generation?.media.frameRate.toFixed(2)}fps</span></div>
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
              <p>导入哈希：<code>{generation?.sourceHash}</code></p>
            </article>
          </div>
          <article className="quality-form-card">
            <header><div><span>NINE DIMENSIONS</span><strong>逐项人工判断</strong></div><small>未观看的项目必须保留为“未审核”</small></header>
            <div className="dimension-grid">
              {form.dimensions.map((item, index) => <div className={`dimension-row ${item.status}`} key={item.dimension}>
                <strong>{String(index + 1).padStart(2, "0")} · {reviewDimensionLabels[item.dimension]}</strong>
                <select value={item.status} onChange={(event) => updateDimension(index, "status", event.target.value)}>
                  <option value="not-reviewed">未审核</option><option value="pass">通过</option><option value="warning">警告</option><option value="fail">失败</option>
                </select>
                <input value={item.note} onChange={(event) => updateDimension(index, "note", event.target.value)} placeholder="判断说明" />
                <input value={item.evidence} onChange={(event) => updateDimension(index, "evidence", event.target.value)} placeholder="时间码 / 可见证据" />
              </div>)}
            </div>
            <div className="quality-decision-grid">
              <label><span>总决策</span><select value={form.decision} onChange={(event) => setForm((current) => ({ ...current, decision: event.target.value as QualityDecision }))}>{Object.entries(qualityDecisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="wide"><span>审核摘要</span><textarea value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} /></label>
              <label><span>通过条件（每行一条）</span><textarea value={conditionsText} onChange={(event) => setConditionsText(event.target.value)} /></label>
              <label><span>重试说明（每行一条）</span><textarea value={retryText} onChange={(event) => setRetryText(event.target.value)} /></label>
              <label className="wide"><span>未验证声明（每行一条）</span><textarea value={unverifiedText} onChange={(event) => setUnverifiedText(event.target.value)} /></label>
            </div>
            <div className="quality-actions">
              <button className="primary" disabled={generation?.status !== "review" || Boolean(busy)} onClick={() => void submitReview()}>{busy === "review" ? "正在保存不可变记录…" : generation?.status === "review" ? "保存人工质检结论" : "该版本已完成质检"}</button>
              <button className="secondary" disabled={!canRender || !center.mediaTools.ffmpegAvailable || !center.mediaTools.ffprobeAvailable || Boolean(busy) || !(project.currentStage === "GENERATION_REVIEW" || project.currentStage === "EDITING")} onClick={() => void renderRoughCut()}>{busy === "render" ? "FFmpeg 正在粗剪…" : "创建新粗剪版本"}</button>
            </div>
            {(!center.mediaTools.ffmpegAvailable || !center.mediaTools.ffprobeAvailable) && <p className="tool-block">本机缺少 FFmpeg / ffprobe，粗剪按钮已拦截；质检记录仍可正常保存。</p>}
          </article>
        </>
      )}
    </section>
  );
}

function DeliveryWorkspace({ project, onBack, onProjectUpdate, onError }: {
  project: Project;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const [center, setCenter] = useState<QualityCenter | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const result = await api.qualityCenter(project.id);
    setCenter(result);
    setSelectedRenderId((current) => result.renders.some((item) => item.id === current)
      ? current
      : result.renders[0]?.id ?? "");
  }

  useEffect(() => {
    void load().catch((reason: Error) => onError(reason.message));
  }, [project.id, project.updatedAt]);

  const render = center?.renders.find((item) => item.id === selectedRenderId) ?? null;

  async function decide(decision: "approved" | "rejected") {
    if (decision === "approved" && !window.confirm("批准后将复制为新的交付目录并把项目标记为已交付。是否继续？")) return;
    setBusy(true);
    setNotice(null);
    onError(null);
    try {
      const result = await api.decideRender(project.id, selectedRenderId, decision, comment);
      onProjectUpdate(result.project);
      await load();
      setNotice(decision === "approved"
        ? "终审已批准，交付文件已复制到独立版本目录。"
        : "终审已驳回，项目已返回剪辑阶段，旧粗剪仍完整保留。");
      setComment("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "终审失败");
    } finally {
      setBusy(false);
    }
  }

  if (!center) return <div className="empty-state"><div className="loader" /><p>正在读取粗剪和交付历史…</p></div>;
  return (
    <section className="delivery-workspace">
      <button className="back-link" onClick={onBack}>← 返回项目总览</button>
      <div className="quality-head">
        <div><span className="eyebrow">FINAL REVIEW & DELIVERY</span><h1>{project.title} · 成片交付</h1><p>每次粗剪与交付均创建新版本；批准、驳回和文件哈希永久留档。</p></div>
        <div className="quality-skill"><span>PROJECT STATE</span><strong>{stageLabels[project.currentStage]}</strong><code>{center.renders.length} 个粗剪版本</code></div>
      </div>
      {notice && <div className="success-notice">✓ {notice}</div>}
      {!center.renders.length ? (
        <div className="quality-empty"><strong>尚未创建粗剪</strong><p>全部镜头通过九维审核后，在“质量审核”中创建第一个本地粗剪版本。</p></div>
      ) : (
        <div className="delivery-layout">
          <article className="render-list">
            <header><span>VERSION HISTORY</span><strong>粗剪版本</strong></header>
            {center.renders.map((item) => <button className={item.id === selectedRenderId ? "active" : ""} key={item.id} onClick={() => setSelectedRenderId(item.id)}><code>V{String(item.version).padStart(3, "0")}</code><span>{item.status}</span><small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small></button>)}
          </article>
          <article className="delivery-player">
            <header><span>RENDER PREVIEW</span><strong>{render ? `粗剪 V${String(render.version).padStart(3, "0")}` : "未选择"}</strong></header>
            {render && render.status !== "failed" && <video key={render.id} controls preload="metadata" src={api.renderMediaUrl(project.id, render.id)} />}
            {render?.error && <p className="preflight-error">{render.error}</p>}
            {render && <dl>
              <div><dt>粗剪</dt><dd>{render.videoPath}</dd></div>
              <div><dt>字幕</dt><dd>{render.subtitlePath ?? "无"}</dd></div>
              <div><dt>报告</dt><dd>{render.reportPath}</dd></div>
              <div><dt>交付文件</dt><dd>{render.deliveryVideoPath ?? "尚未批准"}</dd></div>
            </dl>}
          </article>
          <article className="delivery-decision">
            <header><span>HUMAN GATE</span><strong>成片终审</strong></header>
            <p>批准会复制到独立交付目录；驳回会返回剪辑阶段，不删除当前版本。</p>
            <label><span>终审意见</span><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="驳回时必填；批准时可选" /></label>
            <div><button className="secondary danger" disabled={project.currentStage !== "FINAL_REVIEW" || render?.status !== "review" || busy} onClick={() => void decide("rejected")}>驳回并返回剪辑</button><button className="primary" disabled={project.currentStage !== "FINAL_REVIEW" || render?.status !== "review" || busy} onClick={() => void decide("approved")}>批准并创建交付版本</button></div>
          </article>
        </div>
      )}
    </section>
  );
}

function AssetLibraryWorkspace({ project, onBack, onProjectUpdate, onError }: { project: Project; onBack: () => void; onProjectUpdate: (project: Project) => void; onError: (message: string | null) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [designMode, setDesignMode] = useState<AssetDesignMode>("original-proposal");
  const [busy, setBusy] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  async function loadAssets() {
    const result = await api.listAssets(project.id);
    setAssets(result.assets);
  }
  useEffect(() => {
    setLoading(true);
    void loadAssets().catch((reason: Error) => onError(reason.message)).finally(() => setLoading(false));
  }, [project.id]);
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
    onError(null);
    try {
      const result = await api.generateArtifact(project.id, "asset-bible", { designMode });
      onProjectUpdate(result.project);
      await loadAssets();
      setNotice("新的资产定义版本已生成；旧人物设定和下游导演脚本已保留为过期历史。请检查设定并上传需要的参考图。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "资产设定生成失败");
    } finally {
      setBusy(null);
      setStartedAt(null);
    }
  }

  async function uploadReference(assetId: string, file: File, role: string) {
    setBusy(`upload:${assetId}`);
    onError(null);
    try {
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      const result = await api.uploadAssetReference(project.id, assetId, { fileName: file.name, mimeType: file.type, dataBase64, role, authorizationConfirmed: true });
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      setNotice(`${assetId} 的${role}参考图已保存到项目目录并计算 SHA256。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "参考图上传失败");
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
      {notice && <div className="success-notice">✓ {notice}</div>}
      {incomplete > 0 && <div className="rejection-lock"><strong>检测到 {incomplete} 个空壳或待补充资产</strong><p>这些资产不能作为稳定人物设定进入后续生成。选择“原创完整设定”重做，或在资产审核阶段上传参考图。</p></div>}
      {loading ? <div className="empty-state"><div className="loader" /><p>正在载入素材主库…</p></div> : <AssetBiblePanel assets={assets} projectId={project.id} editable={canUpload} busy={busy} onUpload={uploadReference} />}
      {regenerateOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRegenerateOpen(false)}><div className="project-modal asset-design-modal" role="dialog" aria-modal="true" aria-labelledby="asset-design-title"><div className="modal-head"><div><span className="eyebrow">ASSET DESIGN MODE</span><h2 id="asset-design-title">重做人物与场景设定</h2></div><button type="button" className="close" onClick={() => setRegenerateOpen(false)}>×</button></div><div className="asset-design-options">{(Object.entries(assetDesignModeLabels) as Array<[AssetDesignMode, { title: string; detail: string }]>).map(([value, copy]) => <label className={designMode === value ? "selected" : ""} key={value}><input type="radio" name="asset-design-mode" checked={designMode === value} onChange={() => setDesignMode(value)} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></label>)}</div><div className="rejection-lock"><strong>版本影响与等待时间</strong><p>将创建新的资产定义版本，并让当前导演脚本及后续内容失效；历史文件不会删除。复杂资产通常需要 2–8 分钟，最长等待 12 分钟。</p></div><div className="modal-footer"><button className="secondary" onClick={() => setRegenerateOpen(false)}>取消</button><button className="primary" onClick={() => void regenerate()}>确认并开始生成</button></div></div></div>}
    </section>
  );
}

function StageWorkspace({ project, onBack, onProjectUpdate, onError }: {
  project: Project;
  onBack: () => void;
  onProjectUpdate: (project: Project) => void;
  onError: (message: string | null) => void;
}) {
  const type = artifactTypeForStage(project.currentStage);
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
  const [confirmTarget, setConfirmTarget] = useState<ArtifactType | null>(null);
  const [assetDesignMode, setAssetDesignMode] = useState<AssetDesignMode>("original-proposal");
  const [runningTarget, setRunningTarget] = useState<ArtifactType | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationElapsedSec, setGenerationElapsedSec] = useState(0);

  const selected = artifacts.find((item) => item.id === selectedId) ?? artifacts[0] ?? null;
  const latest = artifacts[0] ?? null;
  const compared = artifacts.find((item) => item.id === compareId) ?? null;
  const dirty = editor.trim() !== (selected?.content.trim() ?? "");

  async function load(preferredId?: string) {
    const [sourceResult, artifactResult, assetResult, shotResult] = await Promise.all([
      api.getSource(project.id),
      api.listArtifacts(project.id, type),
      api.listAssets(project.id),
      api.listShots(project.id),
    ]);
    setSource(sourceResult.sourceText);
    setSourcePath(sourceResult.sourcePath);
    setArtifacts(artifactResult.artifacts);
    const preferred = artifactResult.artifacts.find((item) => item.id === preferredId) ?? artifactResult.artifacts[0] ?? null;
    setSelectedId(preferred?.id ?? null);
    setEditor(preferred?.content ?? "");
    setCompareId(artifactResult.artifacts.find((item) => item.id !== preferred?.id)?.id ?? "");
    setAssets(assetResult.assets);
    setShots(shotResult.shots);
    const activeShot = shotResult.shots.find((shot) => shot.id === activeShotId) ?? shotResult.shots[0] ?? null;
    setActiveShotId(activeShot?.id ?? null);
    setShotDraft(activeShot);
  }

  useEffect(() => {
    setLoadingStage(true);
    void load().catch((reason: Error) => onError(reason.message)).finally(() => setLoadingStage(false));
  }, [project.id, type]);

  useEffect(() => {
    if (generationStartedAt == null) return;
    const update = () => setGenerationElapsedSec(Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt]);

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

  async function run(label: string, action: () => Promise<{ project: Project; artifact?: Artifact }>) {
    const operationStartedAt = Date.now();
    setBusy(label);
    if (label === "generate") {
      setGenerationStartedAt(operationStartedAt);
      setGenerationElapsedSec(0);
    }
    setNotice(null);
    setEditorInfo(null);
    onError(null);
    try {
      const result = await action();
      onProjectUpdate(result.project);
      await load(result.artifact?.id);
      if (label === "reject") setComment("");
      setNotice(label === "save" ? "已另存为不可覆盖的新版本。" : label === "shot-save" ? "镜头修改已保存为新的导演脚本版本，原审批已失效。" : label === "approve" ? "批准成功：审批已绑定版本哈希，项目已进入下一阶段。" : label === "reject" ? "驳回成功：当前版本已锁定，必须产生新版本后才能再次审批。" : `Skill 驱动的 Codex 已完成结构化生成（用时 ${formatElapsed(Math.max(1, Math.round((Date.now() - operationStartedAt) / 1_000)))}），结果等待你的人工审核。` );
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
      if (label === "generate") {
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
    void run("save", () => api.saveArtifact(project.id, type, editor));
  }

  function saveShotVersion() {
    if (!shotDraft) return;
    void run("shot-save", () => api.updateShot(project.id, shotDraft));
  }

  async function confirmGeneration() {
    const target = confirmTarget;
    if (!target) return;
    setConfirmTarget(null);
    setRunningTarget(target);
    await run("generate", () => api.generateArtifact(project.id, target, target === "asset-bible" ? { designMode: assetDesignMode } : undefined));
  }

  async function uploadReference(assetId: string, file: File, role: string) {
    setBusy(`upload:${assetId}`);
    onError(null);
    try {
      if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
      const dataBase64 = await fileAsBase64(file);
      const result = await api.uploadAssetReference(project.id, assetId, { fileName: file.name, mimeType: file.type, dataBase64, role, authorizationConfirmed: true });
      setAssets((current) => current.map((asset) => asset.id === result.asset.id ? result.asset : asset));
      setNotice(`${assetId} 的${role}参考图已保存并绑定。`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "参考图上传失败");
    } finally {
      setBusy(null);
    }
  }

  const isCurrentReview = project.currentStage === reviewStageByArtifact[type];
  const h3IncompatibleShots = type === "shooting-script" ? shots.filter((shot) => shot.durationSec < 4 || shot.durationSec > 15) : [];
  const incompleteAssets = type === "asset-bible" ? assets.filter(assetNeedsDesign) : [];
  const canApprove = Boolean(isCurrentReview && latest?.status === "draft" && selected?.id === latest.id && !h3IncompatibleShots.length && !incompleteAssets.length);
  const canReject = Boolean(canApprove && comment.trim());
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
  const nextTarget = nextArtifactByApprovedStage[project.currentStage] ?? null;
  const structuredStage = !(["outline", "screenplay"] as ArtifactType[]).includes(type);
  const diffRows = compared ? editor.split(/\r?\n/).map((line, index) => ({ current: line, previous: compared.content.split(/\r?\n/)[index] ?? "" })).filter((row) => row.current !== row.previous).slice(0, 60) : [];

  if (loadingStage) return <div className="empty-state"><div className="loader" /><p>正在载入阶段版本…</p></div>;

  return (
    <section className="stage-workbench">
      <div className="workbench-head">
        <div><button className="back-link" onClick={onBack}>← 返回项目总览</button><span className="eyebrow">HUMAN-GATED PRODUCTION WORKFLOW</span><h1>{project.title} · {artifactLabels[type]}</h1><p>{stageLabels[project.currentStage]} · 所有编辑均另存新版本</p></div>
        <div className="workbench-head-actions">
          {nextTarget ? <button className="primary" disabled={Boolean(busy)} onClick={() => requestGeneration(nextTarget)}>{busy === "generate" ? `Skill 正在生成${artifactLabels[nextTarget]}…` : `使用 Skill 生成${artifactLabels[nextTarget]} →`}</button> :
            !project.currentStage.endsWith("_APPROVED") && <button className="primary" disabled={Boolean(busy)} onClick={() => requestGeneration(type)}>{busy === "generate" ? `Skill 正在生成${artifactLabels[type]}…` : `${latest ? "使用 Skill 重新" : "使用 Skill "}生成${artifactLabels[type]}`}</button>}
        </div>
      </div>

      {notice && <div className="success-notice">✓ {notice}</div>}
      {editorInfo && <div className="info-notice">! {editorInfo}</div>}
      {busy === "generate" && runningTarget && <div className="generation-progress"><div className="loader mini" /><div><strong>Skill 正在驱动 Codex 生成{artifactLabels[runningTarget]} · 已等待 {formatElapsed(generationElapsedSec)}</strong><p>{generationExpectations[runningTarget]}。请求仍在等待本地 Codex 返回；请保持页面打开，系统不会因等待而重复提交。</p></div><b>{formatElapsed(generationElapsedSec)}</b></div>}
      {h3IncompatibleShots.length > 0 && <div className="rejection-lock"><strong>当前导演脚本无法进入 H3 投递</strong><p>H3 一镜一任务要求每镜 4–15 秒；当前 {h3IncompatibleShots.length} 个镜头不兼容（{h3IncompatibleShots.map((shot) => `${shot.id} ${shot.durationSec}s`).join("、")}）。本项目 15 秒，最多建议 3 个约 5 秒的连续镜头。请驳回当前版本并重新生成。</p></div>}
      {incompleteAssets.length > 0 && <div className="rejection-lock"><strong>当前资产定义不能批准</strong><p>{incompleteAssets.map((asset) => `${asset.id} ${asset.name}`).join("、")} 尚未形成可制作的人物／视觉设定。请使用原创完整设定重新生成，或上传参考图。</p></div>}
      {nextTarget && <div className="stage-complete-card"><span>✓</span><div><strong>{artifactLabels[type]}已经批准并锁定</strong><p>审批哈希已写入本地记录。下一步将严格依据已批准版本生成{artifactLabels[nextTarget]}，不会自动批准。</p></div><button className="primary" disabled={Boolean(busy)} onClick={() => requestGeneration(nextTarget)}>进入{artifactLabels[nextTarget]}阶段 →</button></div>}
      {project.currentStage === "STORYBOARD_APPROVED" && <div className="stage-complete-card"><span>✓</span><div><strong>Phase 3 已完成</strong><p>资产、ShotSpec、分镜和连续性报告均已形成批准版本；下一阶段将进入 H3 与 Updream 投递。</p></div></div>}
      <div className="three-column-workbench">
        <article className="work-panel source-panel">
          <div className="work-panel-head"><span>01 / 原始内容</span><b>LOCKED</b></div>
          <p className="panel-help">不可变原件，仅供逐项核对。</p>
          <pre>{source}</pre>
          <code title={sourcePath}>{sourcePath}</code>
        </article>

        <article className="work-panel editor-panel">
          <div className="work-panel-head"><span>02 / 当前版本</span><b>{selected ? `V${String(selected.version).padStart(3, "0")}` : "未生成"}</b></div>
          <div className="version-tools">
            <label>编辑版本<select value={selected?.id ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={!artifacts.length}>{artifacts.length ? artifacts.map((item) => <option key={item.id} value={item.id}>V{String(item.version).padStart(3, "0")} · {artifactStatusLabels[item.status]}</option>) : <option value="">尚无版本</option>}</select></label>
            <label>对比版本<select value={compareId} onChange={(event) => setCompareId(event.target.value)} disabled={artifacts.length < 2}><option value="">不对比</option>{artifacts.filter((item) => item.id !== selected?.id).map((item) => <option key={item.id} value={item.id}>V{String(item.version).padStart(3, "0")}</option>)}</select></label>
          </div>
          {type === "asset-bible" ? <AssetBiblePanel assets={assets} projectId={project.id} editable={project.currentStage === "ASSET_BIBLE_REVIEW"} busy={busy} onUpload={uploadReference} /> : type === "shooting-script" ? <ShotEditor shots={shots} activeShotId={activeShotId} draft={shotDraft} busy={Boolean(busy)} onSelect={selectShot} onChange={setShotDraft} onSave={saveShotVersion} /> : <textarea className={structuredStage ? "structured-preview" : ""} readOnly={structuredStage} value={editor} onChange={(event) => { setEditor(event.target.value); setEditorInfo(null); }} placeholder={`使用 Skill 生成${artifactLabels[type]}草案…`} />}
          <div className="editor-footer"><span>{selected ? `${artifactStatusLabels[selected.status]} · SHA256 ${selected.contentHash.slice(0, 10)}…` : "尚未创建产物文件"}</span>{!structuredStage && <button className="secondary" disabled={Boolean(busy) || !editor.trim()} onClick={saveEditorVersion}>{busy === "save" ? "正在保存…" : dirty || !selected ? "另存为新版本" : "检查并另存"}</button>}</div>
          {compared && <div className="diff-card"><div><strong>与 V{String(compared.version).padStart(3, "0")} 的逐行差异</strong><small>{diffRows.length ? `显示 ${diffRows.length} 处` : "内容相同"}</small></div>{diffRows.map((row, index) => <p key={`${index}-${row.current}`}><del>{row.previous || "（空）"}</del><ins>{row.current || "（空）"}</ins></p>)}</div>}
        </article>

        <article className="work-panel review-panel">
          <div className="work-panel-head"><span>03 / 建议与审批</span><b>HUMAN ONLY</b></div>
          <p className="panel-help">Codex 只能生成草案，不能替你批准。</p>
          <div className={`skill-execution-card ${executedSkills.length ? "active" : "manual"}`}>
            <small>实际执行链路</small>
            {executedSkills.length ? <><strong>{executedSkills.map((skill) => skill.name).join(" → ")}</strong>{executedSkills.map((skill) => <code key={`${skill.name}-${skill.sha256}`}>{skill.name} · v{skill.version} · {skill.sha256.slice(0, 10)}…</code>)}</> : <><strong>无 Skill 执行记录</strong><p>这是旧版产物或人工编辑版本。</p></>}
          </div>
          <div className="suggestion-box"><small>{type === "outline" ? "剧情修改建议" : "结构约束"}</small><p>{suggestions}</p></div>
          {latest?.status === "rejected" && <div className="rejection-lock"><strong>当前版本已驳回并锁定</strong><p>不能再次批准同一文件。请在中间栏修改后“另存为新版本”，或点击上方重新生成。</p></div>}
          <div className="approval-facts"><div><span>当前版本</span><b>{selected ? `V${String(selected.version).padStart(3, "0")}` : "无"}</b></div><div><span>审批状态</span><b>{selected ? artifactStatusLabels[selected.status] : "等待生成"}</b></div><div><span>历史版本</span><b>{artifacts.length}</b></div></div>
          <label className="review-comment"><span>审批意见（驳回时必填）</span><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="批准时可选；驳回时请写明修改要求…" /></label>
          <div className="approval-actions"><button className="danger secondary" disabled={!canReject || Boolean(busy)} onClick={() => latest && void run("reject", () => api.decide(project.id, project.currentStage, latest.id, "reject", comment))}>驳回并锁定</button><button className="primary" disabled={!canApprove || Boolean(busy)} onClick={() => latest && void run("approve", () => api.decide(project.id, project.currentStage, latest.id, "approve", comment))}>批准并进入下一阶段</button></div>
          {!canApprove && <p className="gate-note">{incompleteAssets.length ? "批准按钮已锁定：必须先完成所有人物与视觉资产设定，或上传有效参考图。" : h3IncompatibleShots.length ? "批准按钮已锁定：先驳回并生成符合 4–15 秒单镜头限制的新版本。" : project.currentStage.endsWith("_APPROVED") ? "此阶段已批准。编辑并另存新版本后，原批准会失效并回到审核。" : latest?.status === "rejected" ? "该版本已驳回；只有新生成或另存的版本才能再次审批。" : latest && selected?.id !== latest.id ? "历史版本只读回看；只能审批最新版本。" : "生成或保存一个版本后才能审批。"}</p>}
        </article>
      </div>
      {confirmTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmTarget(null)}><div className="project-modal generation-confirm" role="dialog" aria-modal="true" aria-labelledby="generation-confirm-title"><div className="modal-head"><div><span className="eyebrow">SKILL-DRIVEN CODEX</span><h2 id="generation-confirm-title">生成{artifactLabels[confirmTarget]}草案</h2></div><button type="button" className="close" onClick={() => setConfirmTarget(null)}>×</button></div><div className="generation-confirm-body"><div className="generation-symbol">AI</div><div><strong>即将由本地 Skill 驱动真实 Codex 任务</strong><p>系统会显式加载 producer、当前阶段 Skill 与已批准上游内容。不会调用付费视频 API，也不会自动批准结果。</p></div>{confirmTarget === "asset-bible" && <div className="asset-design-options compact-options">{(Object.entries(assetDesignModeLabels) as Array<[AssetDesignMode, { title: string; detail: string }]>).map(([value, copy]) => <label className={assetDesignMode === value ? "selected" : ""} key={value}><input type="radio" name="stage-asset-design-mode" checked={assetDesignMode === value} onChange={() => setAssetDesignMode(value)} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></label>)}</div>}<dl><div><dt>Skill 路由</dt><dd>{generationRoutes[confirmTarget]}</dd></div><div><dt>预计等待</dt><dd>{generationExpectations[confirmTarget]}</dd></div><div><dt>权限</dt><dd>只读本地项目</dd></div><div><dt>生成后</dt><dd>停在人工审核</dd></div></dl></div><div className="modal-footer"><button type="button" className="secondary" onClick={() => setConfirmTarget(null)}>取消</button><button type="button" className="primary" onClick={() => void confirmGeneration()}>确认并开始生成</button></div></div></div>}
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

function AssetBiblePanel({ assets, projectId, editable = false, busy = null, onUpload }: {
  assets: Asset[];
  projectId?: string;
  editable?: boolean;
  busy?: string | null;
  onUpload?: (assetId: string, file: File, role: string) => Promise<void>;
}) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  if (!assets.length) return <div className="structured-empty"><strong>尚未生成资产定义</strong><p>批准影视剧本后，使用 Skill 提取角色、场景、道具、服装、风格与声音。</p></div>;
  return (
    <div className="asset-bible-grid">
      {assets.map((asset) => <article className={`asset-definition-card ${assetNeedsDesign(asset) ? "incomplete" : "ready"}`} key={asset.id}>
        <div><span>{asset.id}</span><b>{assetTypeLabels[asset.type]} · {assetNeedsDesign(asset) ? "设计不完整" : "可制作"}</b></div>
        <h3>{asset.name}</h3>
        <p>{asset.identity}</p>
        {projectId && asset.localFiles.length > 0 && <div className="asset-reference-grid">{asset.localFiles.map((_file, index) => <figure key={`${asset.id}-${index}`}><img src={api.assetReferenceUrl(projectId, asset.id, index)} alt={`${asset.name} ${asset.fileRoles[index] ?? "参考图"}`} /><figcaption>{asset.fileRoles[index] ?? (index === 0 ? "主参考" : `参考 ${index + 1}`)}</figcaption></figure>)}</div>}
        <dl>
          <div><dt>设计依据</dt><dd>{asset.designBasis === "creative-proposal" ? "原创设计提案" : asset.designBasis === "reference-guided" ? "参考图锁定" : "剧本／原文依据"}</dd></div>
          <div><dt>视觉摘要</dt><dd>{asset.designSummary || "未提供"}</dd></div>
          <div><dt>完整外观</dt><dd>{asset.appearance}</dd></div>
          <div><dt>固定识别特征</dt><dd>{asset.distinctiveFeatures.join("；") || "未提供"}</dd></div>
          <div><dt>禁止漂移</dt><dd>{asset.negativeConstraints.join("；") || "未提供"}</dd></div>
          <div><dt>连续性</dt><dd>{asset.continuityRules.join("；") || "无"}</dd></div>
          <div className={asset.unknowns.length ? "unresolved" : ""}><dt>未知项</dt><dd>{asset.unknowns.join("；") || "无"}</dd></div>
          <div><dt>镜头引用</dt><dd>{asset.referencedBy.join("、") || "尚未引用"}</dd></div>
        </dl>
        {editable && visualAssetTypesForUi.has(asset.type) && onUpload && <div className="asset-reference-actions"><select aria-label={`${asset.name}参考图类型`} value={roles[asset.id] ?? "主参考"} onChange={(event) => setRoles((current) => ({ ...current, [asset.id]: event.target.value }))}><option>主参考</option><option>正面</option><option>侧面</option><option>背面</option><option>表情</option><option>服装</option><option>其他</option></select><label className={`secondary file-button ${busy === `upload:${asset.id}` ? "disabled" : ""}`}>{busy === `upload:${asset.id}` ? "正在保存…" : "＋ 上传参考图"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy)} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void onUpload(asset.id, file, roles[asset.id] ?? "主参考"); }} /></label></div>}
        <footer><span>{assetNeedsDesign(asset) ? asset.approved ? "旧版批准 · 现已拦截" : "不可批准" : asset.approved ? "已批准" : "待审核"}</span><code>V{String(asset.version).padStart(3, "0")} · {asset.localFiles.length} 图</code></footer>
      </article>)}
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
      <div className="shot-timeline">{shots.map((shot) => <button className={shot.id === activeShotId ? "active" : ""} key={shot.id} onClick={() => onSelect(shot.id)}><b>{shot.id}</b><span>{shot.startTimeSec}–{shot.endTimeSec}s</span></button>)}</div>
      <div className="shot-editor-head"><div><span>{draft.id}</span><strong>{draft.startTimeSec.toFixed(2)}–{draft.endTimeSec.toFixed(2)} 秒</strong></div><b>{draft.status}</b></div>
      <div className="shot-form-grid">
        <label><span>镜头目的</span><input value={draft.purpose} onChange={(event) => change("purpose", event.target.value)} /></label>
        <label><span>景别</span><input value={draft.shotSize} onChange={(event) => change("shotSize", event.target.value)} /></label>
        <label><span>机位</span><input value={draft.camera.position} onChange={(event) => change("camera", { ...draft.camera, position: event.target.value })} /></label>
        <label><span>运镜</span><input value={draft.camera.movement} onChange={(event) => change("camera", { ...draft.camera, movement: event.target.value })} /></label>
        <label className="full"><span>动作与表演</span><textarea value={draft.action} onChange={(event) => change("action", event.target.value)} /></label>
        <label className="full"><span>起始状态</span><textarea value={draft.startState} onChange={(event) => change("startState", event.target.value)} /></label>
        <label className="full"><span>结束状态</span><textarea value={draft.endState} onChange={(event) => change("endState", event.target.value)} /></label>
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
    ["文字 Skill", health?.skillDrivenTextGeneration ? `${health.textSkills.length} 个已校验` : health?.skillLoadError ?? "未启用", health?.skillDrivenTextGeneration],
    ["H3 Skill", h3Skill ? h3Skill.version : "未载入", Boolean(h3Skill)],
    ["FFmpeg", health?.mediaTools.ffmpegAvailable && health.mediaTools.ffprobeAvailable ? "已就绪" : "尚未检测到", Boolean(health?.mediaTools.ffmpegAvailable && health.mediaTools.ffprobeAvailable)],
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

function CreateProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: CreateProjectInput) => Promise<void> }) {
  const [form, setForm] = useState(emptyForm);
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "edit") {
      setStep("confirm");
      return;
    }
    setSaving(true);
    setError(null);
    try { await onCreate(form); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="project-modal" onSubmit={submit}>
        <div className="modal-head"><div><span className="eyebrow">NEW PRODUCTION</span><h2>{step === "edit" ? "创建本地视频项目" : "确认接入路线"}</h2></div><button type="button" className="close" onClick={onClose}>×</button></div>
        {step === "edit" ? (
          <div className="form-grid">
            <label className="full"><span>项目名称</span><input autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例如：雨夜来客" /></label>
            <label><span>输入类型</span><select value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value as SourceType })}>{Object.entries(sourceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label><span>目标时长（秒）</span><input required min="1" max="21600" type="number" value={form.targetDurationSec} onChange={(e) => setForm({ ...form, targetDurationSec: Number(e.target.value) })} /></label>
            <label><span>画幅</span><select value={form.aspectRatio} onChange={(e) => setForm({ ...form, aspectRatio: e.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
            <label><span>分辨率</span><select value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })}><option>1920x1080</option><option>1080x1920</option><option>1280x720</option></select></label>
            <label><span>视频类型</span><input value={form.videoType} onChange={(e) => setForm({ ...form, videoType: e.target.value })} /></label>
            <label><span>发布平台</span><input value={form.releasePlatform} onChange={(e) => setForm({ ...form, releasePlatform: e.target.value })} placeholder="可选" /></label>
            <label className="full"><span>视觉风格</span><input value={form.visualStyle} onChange={(e) => setForm({ ...form, visualStyle: e.target.value })} placeholder="例如：冷灰电影感，克制手持摄影" /></label>
            <label className="full"><span>原始内容</span><textarea required value={form.sourceText} onChange={(e) => setForm({ ...form, sourceText: e.target.value })} placeholder="粘贴故事、剧本、导演脚本或分镜内容…" /></label>
            <label className="check full"><input type="checkbox" checked={form.allowStorySuggestions} onChange={(e) => setForm({ ...form, allowStorySuggestions: e.target.checked })} /><span>允许系统提出剧情修改建议（不会自动改写）</span></label>
          </div>
        ) : (
          <div className="confirm-route">
            <div className="route-icon">{form.sourceType === "story" ? "01" : form.sourceType === "screenplay" ? "03" : form.sourceType === "shooting-script" ? "05" : "06"}</div>
            <div><span className="eyebrow">DETECTED ENTRY</span><h3>{sourceLabels[form.sourceType]}</h3><p>系统将从对应阶段继续，不重复已经完成的工作。原始内容保存为不可变 V001，后续每次批准都会记录文件哈希。</p></div>
            <dl><div><dt>项目</dt><dd>{form.title}</dd></div><div><dt>成片目标</dt><dd>{form.targetDurationSec} 秒 · {form.aspectRatio} · {form.resolution}</dd></div><div><dt>自动付费</dt><dd>关闭</dd></div></dl>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-footer"><button type="button" className="secondary" onClick={() => step === "confirm" ? setStep("edit") : onClose()}>{step === "confirm" ? "返回修改" : "取消"}</button><button className="primary" disabled={saving}>{saving ? "正在创建…" : step === "edit" ? "识别接入路线 →" : "确认并创建项目"}</button></div>
      </form>
    </div>
  );
}
