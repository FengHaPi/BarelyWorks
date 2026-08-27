import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../../../src/shared/api-contracts/agent-first";
import { api } from "../../api";
import type { GenerationCenter, GenerationResolution, HandoffPackageSummary } from "../../types";
import { ShotPackageWorkspace } from "./ShotPackageWorkspace";

export function GenerationWorkspace({ projectId, workspace, onChanged, onOperation }: {
  projectId: string;
  workspace: ProjectWorkspace;
  onChanged: () => Promise<void> | void;
  onOperation: (operationId: string) => void;
}) {
  const [center, setCenter] = useState<GenerationCenter | null>(null);
  const [resolution, setResolution] = useState<GenerationResolution>("platform-default");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ shotId: string; version: number; content: string } | null>(null);
  const snapshots = workspace.snapshots.filter((snapshot) => snapshot.kind === "generation");

  async function reload() {
    setError(null);
    try { setCenter(await api.generationCenter(projectId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "生成中心载入失败"); }
  }
  useEffect(() => { void reload(); }, [projectId, workspace.operations[0]?.finishedAt]);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(success); await reload(); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(null); }
  }

  async function openPrompt(shotId: string, item: HandoffPackageSummary) {
    setBusy(`prompt:${shotId}:${item.version}`); setError(null);
    try {
      const result = await api.readUpdreamPrompt(projectId, shotId, item.version);
      setPrompt({ shotId, version: item.version, content: result.prompt });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提示词读取失败"); }
    finally { setBusy(null); }
  }

  async function scanInbox() {
    setBusy("scan"); setError(null); setNotice(null);
    try {
      const result = await api.createProductionInboxScan(projectId, crypto.randomUUID());
      onOperation(result.operationId);
      setNotice("视频扫描导入作业已创建；进度、逐文件错误和取消状态显示在右侧。");
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "视频导入扫描失败"); }
    finally { setBusy(null); }
  }

  async function runOperation(key: string, action: () => Promise<{ operationId: string }>, success: string) {
    setBusy(key); setError(null); setNotice(null);
    try { const result = await action(); onOperation(result.operationId); setNotice(success); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "作业创建失败"); }
    finally { setBusy(null); }
  }

  return <section className="af-content-panel af-resource-workspace">
    <header><div><span className="af-kicker">显式制作命令</span><h2>镜头包与视频生成</h2></div><span className="af-chip">人工提交保持启用</span></header>
    <div className="af-resource-metrics"><div><b>{workspace.resourceSummary.assets}</b><span>素材记录</span></div><div><b>{workspace.resourceSummary.shots}</b><span>镜头</span></div><div><b>{workspace.resourceSummary.generations}</b><span>生成记录</span></div></div>
    <div className="af-guidance"><strong>批准后从这里继续</strong><p>先准备素材清单，再逐镜头创建 H3 投递包；到 Updream 手工生成后，把文件放入 inbox 并点击扫描。任何动作都不会自动批准或调用付费平台。</p></div>
    {notice && <div className="af-notice">{notice}</div>}
    {error && <div className="af-global-error">{error}</div>}
    <div className="af-command-bar">
      <button className="af-primary-inline" disabled={Boolean(busy)} onClick={() => void runOperation("bootstrap", () => api.createProductionBootstrap(projectId, crypto.randomUUID()), "素材清单作业已创建；完成后才可逐镜头创建投递包。")}>{busy === "bootstrap" ? "提交中…" : center?.bootstrap ? "重新准备素材清单" : "1. 准备素材清单"}</button>
      <label>生成分辨率<select value={resolution} onChange={(event) => setResolution(event.target.value as GenerationResolution)}><option value="platform-default">平台默认</option><option value="720p">720p</option><option value="768p">768p</option><option value="1080p">1080p</option></select></label>
      <button disabled={Boolean(busy)} onClick={() => void scanInbox()}>{busy === "scan" ? "扫描中…" : "3. 扫描并导入视频"}</button>
    </div>
    {!center && !error ? <div className="af-loading-inline">正在读取当前 Head 对应的生成资料…</div> : center ? <>
      <div className="af-generation-list">
        {center.shots.map(({ shot, preflight, packages }) => {
          const latest = packages[0] ?? null;
          return <article className="af-generation-shot" key={shot.id}>
            <header><div><strong>{shot.id}</strong><small>{shot.durationSec.toFixed(2)}s · {shot.purpose}</small></div><span className={preflight.passed ? "ready" : "blocked"}>{preflight.passed ? "预检通过" : "预检阻断"}</span></header>
            {!preflight.passed && <p className="af-blockers">{preflight.errors.join("；")}</p>}
            <div className="af-shot-actions">
              <button disabled={Boolean(busy) || !preflight.passed || !center.bootstrap} onClick={() => void runOperation(`package:${shot.id}`, () => api.createProductionShotPackage(projectId, shot.id, resolution, crypto.randomUUID()), `${shot.id} 投递包作业已创建；完成后再核对提示词和参考素材。`)}>{busy === `package:${shot.id}` ? "提交中…" : "2. 创建新投递包"}</button>
              {latest && <button disabled={Boolean(busy) || latest.isStale} onClick={() => void openPrompt(shot.id, latest)}>查看提示词 V{String(latest.version).padStart(3, "0")}</button>}
              {latest && <button disabled={Boolean(busy) || latest.isStale} onClick={() => void run(`copy:${shot.id}`, () => api.copyUpdreamMaterials(projectId, shot.id, latest.version), `${shot.id} 素材已复制到系统剪贴板。`)}>复制投递素材</button>}
              {latest && <button disabled={Boolean(busy) || latest.isStale} onClick={() => void run(`upload:${shot.id}`, () => api.setPackageUploadState(projectId, shot.id, latest.version, latest.uploadState === "uploaded" ? "not-uploaded" : "uploaded", "agent-first"), `${shot.id} 人工上传状态已更新。`)}>{latest.uploadState === "uploaded" ? "撤销已上传" : "标记已上传"}</button>}
            </div>
            {latest && <small className={latest.isStale ? "af-stale" : ""}>当前包 V{String(latest.version).padStart(3, "0")} · {latest.mode} · {latest.generationResolution} · {latest.uploadState === "uploaded" ? "已人工上传" : "尚未上传"}{latest.isStale ? ` · 已过期：${latest.staleReasons.join("；")}` : ""}</small>}
          </article>;
        })}
      </div>
    </> : null}
    {prompt && <div className="af-prompt-view"><header><strong>{prompt.shotId} 提示词 V{String(prompt.version).padStart(3, "0")}</strong><button onClick={() => setPrompt(null)}>关闭</button></header><textarea readOnly value={prompt.content} /><button onClick={() => void navigator.clipboard.writeText(prompt.content).then(() => setNotice("提示词已复制。"))}>复制提示词</button></div>}
    {snapshots.length ? <ShotPackageWorkspace snapshots={snapshots} /> : <div className="af-empty"><strong>尚无生成记录</strong><p>投递包不是生成结果；导入真实视频后才会出现生成快照。</p></div>}
  </section>;
}
