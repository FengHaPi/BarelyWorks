import { useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../../../src/shared/api-contracts/agent-first";
import { api } from "../../api";
import { reviewDimensions, type ImportedGeneration, type QualityCenter, type QualityDecision, type QualityReviewInput, type ReviewDimension, type ReviewDimensionStatus } from "../../types";

const dimensionLabels: Record<ReviewDimension, string> = {
  identity: "角色身份", "costume-props": "服装道具", scene: "场景", action: "动作", camera: "镜头",
  "composition-direction": "构图方向", "start-end-state": "首尾状态", "picture-quality": "画面质量", "sound-quality": "声音质量",
};
const decisionLabels: Record<QualityDecision, string> = {
  accepted: "正式通过", "conditional-pass": "有条件通过", "retry-same-model": "同模型重试", "revise-prompt-retry": "改提示词重试", "switch-model": "切换模型", "manual-fix": "人工修复",
};

function newReview(): QualityReviewInput {
  return {
    dimensions: reviewDimensions.map((dimension) => ({ dimension, status: "not-reviewed", note: "", evidence: "" })),
    decision: "accepted",
    summary: "",
    conditions: [],
    retryInstructions: [],
    unverifiedClaims: [],
  };
}

export function QualityWorkspace({ projectId, workspace, onChanged }: {
  projectId: string;
  workspace: ProjectWorkspace;
  onChanged: () => Promise<void> | void;
}) {
  const [center, setCenter] = useState<QualityCenter | null>(null);
  const [selected, setSelected] = useState<ImportedGeneration | null>(null);
  const [form, setForm] = useState<QualityReviewInput>(() => newReview());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generationIssues = workspace.issues.filter((issue) => issue.scopeType === "generation" && issue.status === "open");

  async function reload() {
    setError(null);
    try { setCenter(await api.qualityCenter(projectId, "agent-first")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "质检中心载入失败"); }
  }
  useEffect(() => { void reload(); }, [projectId]);

  function begin(job: ImportedGeneration) {
    setSelected(job); setForm(newReview()); setError(null); setNotice(null);
  }
  function updateDimension(dimension: ReviewDimension, patch: Partial<{ status: ReviewDimensionStatus; note: string; evidence: string }>) {
    setForm((current) => ({ ...current, dimensions: current.dimensions.map((item) => item.dimension === dimension ? { ...item, ...patch } : item) }));
  }
  async function submit() {
    if (!selected) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.reviewGeneration(projectId, selected.id, form, "agent-first");
      setNotice(`${selected.shotId} V${String(selected.generationVersion).padStart(3, "0")} 的人工九维质检已保存。`);
      setSelected(null); await reload(); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "质检记录保存失败"); }
    finally { setBusy(false); }
  }

  return <section className="af-content-panel af-resource-workspace">
    <header><div><span className="af-kicker">逐项证据</span><h2>质检工作区</h2></div><span className="af-chip">{workspace.resourceSummary.qualityReviews} 条记录</span></header>
    <div className="af-guidance"><strong>质检只决定具体生成记录</strong><p>每个结论都由人工填写九个维度、证据和总结；不会自动通过，也不会自动进入粗剪。</p></div>
    {notice && <div className="af-notice">{notice}</div>}
    {error && <div className="af-global-error">{error}</div>}
    {generationIssues.map((issue) => <article className={`af-issue-inline ${issue.severity}`} key={issue.id}><strong>{issue.title}</strong><p>{issue.detail}</p></article>)}
    {!center ? <div className="af-loading-inline">正在读取真实生成记录和审核证据…</div> : <div className="af-quality-list">
      {center.generations.map((job) => {
        const review = center.reviews.find((item) => item.jobId === job.id);
        return <article className="af-quality-job" key={job.id}>
          <header><div><strong>{job.shotId} · V{String(job.generationVersion).padStart(3, "0")}</strong><small>{job.sourceFileName}</small></div><span className={job.status}>{job.status}</span></header>
          <video controls preload="metadata" src={api.generationMediaUrl(projectId, job.id)} />
          <p>{job.media.width}×{job.media.height} · {job.media.durationSec.toFixed(2)}s · SHA {job.sourceHash.slice(0, 12)}…</p>
          {review ? <div className="af-review-summary"><strong>{decisionLabels[review.decision]}</strong><p>{review.summary}</p><small>{new Date(review.createdAt).toLocaleString("zh-CN")}</small></div>
            : job.status === "review" ? <button disabled={busy} onClick={() => begin(job)}>开始人工九维质检</button> : <small>该版本当前不能提交新质检。</small>}
        </article>;
      })}
      {!center.generations.length && <div className="af-empty"><strong>尚无可质检视频</strong><p>先在“镜头与视频”中扫描 generation inbox。</p></div>}
    </div>}
    {selected && <div className="af-review-form">
      <header><div><strong>{selected.shotId} V{String(selected.generationVersion).padStart(3, "0")} 人工质检</strong><small>所有结论都必须有人工证据</small></div><button onClick={() => setSelected(null)}>取消</button></header>
      <button className="af-pass-all" onClick={() => setForm((current) => ({ ...current, dimensions: current.dimensions.map((item) => ({ ...item, status: "pass", note: item.note || "人工检查通过", evidence: item.evidence || "已查看完整视频与关键帧" })) }))}>将九项标记为人工已检查通过</button>
      <div className="af-dimension-list">{form.dimensions.map((item) => <article key={item.dimension}>
        <strong>{dimensionLabels[item.dimension]}</strong>
        <select value={item.status} onChange={(event) => updateDimension(item.dimension, { status: event.target.value as ReviewDimensionStatus })}><option value="not-reviewed">未检查</option><option value="pass">通过</option><option value="warning">警告</option><option value="fail">失败</option></select>
        <input value={item.note} onChange={(event) => updateDimension(item.dimension, { note: event.target.value })} placeholder="观察结论" />
        <input value={item.evidence} onChange={(event) => updateDimension(item.dimension, { evidence: event.target.value })} placeholder="时间点或关键帧证据" />
      </article>)}</div>
      <div className="af-review-decision">
        <label>处置<select value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value as QualityDecision })}>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>审核总结<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} placeholder="说明为何通过或为何重试" /></label>
        <label>条件 / 重试要求<textarea value={form.decision === "conditional-pass" ? form.conditions.join("\n") : form.retryInstructions.join("\n")} onChange={(event) => setForm({ ...form, ...(form.decision === "conditional-pass" ? { conditions: event.target.value.split("\n").filter(Boolean) } : { retryInstructions: event.target.value.split("\n").filter(Boolean) }) })} /></label>
        <button className="af-primary-inline" disabled={busy || !form.summary.trim()} onClick={() => void submit()}>{busy ? "保存中…" : "保存这一次人工质检"}</button>
      </div>
    </div>}
  </section>;
}
