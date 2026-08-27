import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../../../src/shared/api-contracts/agent-first";
import { api } from "../../api";
import type { QualityCenter, RenderRecord } from "../../types";

export function EditingWorkspace({ projectId, workspace, onChanged, onOperation }: {
  projectId: string;
  workspace: ProjectWorkspace;
  onChanged: () => Promise<void> | void;
  onOperation: (operationId: string) => void;
}) {
  const [center, setCenter] = useState<QualityCenter | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const snapshots = workspace.snapshots.filter((snapshot) => snapshot.kind === "render" || snapshot.kind === "delivery");

  async function reload() {
    setError(null);
    try { setCenter(await api.qualityCenter(projectId, "agent-first")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "剪辑资料载入失败"); }
  }
  useEffect(() => { void reload(); }, [projectId, workspace.operations[0]?.finishedAt]);
  async function createRender() {
    setBusy("render"); setError(null); setNotice(null);
    try { const result = await api.createProductionRoughCut(projectId, crypto.randomUUID()); onOperation(result.operationId); setNotice("粗剪作业已创建；完成、失败和取消均会持久化显示。" ); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "粗剪创建失败"); }
    finally { setBusy(null); }
  }
  async function decide(render: RenderRecord, decision: "approved" | "rejected") {
    setBusy(`${decision}:${render.id}`); setError(null); setNotice(null);
    try { await api.decideRender(projectId, render.id, decision, comment, "agent-first"); setNotice(decision === "approved" ? "交付版本已显式批准并复制到交付目录。" : "粗剪已驳回，修改意见已保存。"); setComment(""); await reload(); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "交付决定保存失败"); }
    finally { setBusy(null); }
  }

  return <section className="af-content-panel af-resource-workspace">
    <header><div><span className="af-kicker">可追溯剪辑</span><h2>剪辑与交付</h2></div><span className="af-chip">显式创建粗剪</span></header>
    <div className="af-guidance"><strong>旧结果不会被删除，也不会冒充当前结果</strong><p>只有所有镜头的最新生成版本都经过人工正式通过，才能点击创建粗剪；粗剪明确绑定 sourceJobIds，交付还需单独批准。</p></div>
    {notice && <div className="af-notice">{notice}</div>}
    {error && <div className="af-global-error">{error}</div>}
    {center && <div className="af-command-bar">
      <button className="af-primary-inline" disabled={Boolean(busy) || !center.gateAudit.passed || !center.mediaTools.roughCutReady} onClick={() => void createRender()}>{busy === "render" ? "渲染中…" : "创建新粗剪"}</button>
      <span>{center.gateAudit.passed ? "生成审核门禁已通过" : `还不能粗剪：${center.gateAudit.blockers.join("；")}`}</span>
      {!center.mediaTools.roughCutReady && <span className="error">FFmpeg 粗剪能力未就绪</span>}
    </div>}
    {center?.renders.map((render) => <article className="af-render-card" key={render.id}>
      <header><div><strong>粗剪 V{String(render.version).padStart(3, "0")}</strong><small>{render.sourceJobIds.length} 个源视频 · {new Date(render.createdAt).toLocaleString("zh-CN")}</small></div><span className={render.status}>{render.status}</span></header>
      {render.status !== "failed" && <video controls preload="metadata" src={api.renderMediaUrl(projectId, render.id)} />}
      {render.error && <p className="af-blockers">{render.error}</p>}
      {render.status === "review" && <div className="af-delivery-decision"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="交付意见；驳回时必填" /><div><button disabled={Boolean(busy)} onClick={() => void decide(render, "approved")}>批准交付</button><button className="danger" disabled={Boolean(busy) || !comment.trim()} onClick={() => void decide(render, "rejected")}>驳回粗剪</button></div></div>}
      <details><summary>来源版本</summary>{render.sourceJobIds.map((id) => <p key={id}>{id}</p>)}</details>
    </article>)}
    {!center && <div className="af-loading-inline">正在载入粗剪门禁和真实输出…</div>}
    {center && !center.renders.length && <div className="af-empty"><strong>尚无粗剪</strong><p>全部镜头通过人工质检后，“创建新粗剪”才会启用。</p></div>}
    {snapshots.length > 0 && <div className="af-snapshot-grid">{snapshots.map((snapshot) => <article key={snapshot.id} className={`af-snapshot ${snapshot.lineageState}`}><header><strong>{snapshot.label}</strong><span>{snapshot.status}</span></header><p>{snapshot.lineageMessage}</p></article>)}</div>}
  </section>;
}
