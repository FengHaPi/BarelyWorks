import { useState } from "react";
import type { ProjectIssue } from "../../../../src/shared/api-contracts/agent-first";
import type { ContinuityRepairPlan } from "../../../../src/shared/continuity-repair";
import { api } from "../../api";
import type { CumulativeVerificationLedger } from "../../../../src/shared/cumulative-verification";
import { VerificationLedgerPanel } from "../verification/VerificationLedgerPanel";

export function IssueDrawer({ projectId, issues, scopeId, open, onClose, onChanged, onStartStructuredRepair, repairPlan, verificationLedger }: {
  projectId: string;
  issues: ProjectIssue[];
  scopeId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onStartStructuredRepair?: () => Promise<void>;
  repairPlan?: ContinuityRepairPlan | null;
  verificationLedger?: CumulativeVerificationLedger | null;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scoped = issues
    .filter((issue) => issue.status === "open" && (!scopeId || issue.scopeId === scopeId || issue.scopeType === "project"))
    .sort((left, right) => ({ error: 0, warning: 1, info: 2 }[left.severity] - ({ error: 0, warning: 1, info: 2 }[right.severity])));
  async function update(issue: ProjectIssue, status: "resolved" | "ignored") {
    setBusy(issue.id); setError(null); setNotice(null);
    try {
      await api.updateIssue(projectId, issue.id, { status, actor: "user", reason: reasons[issue.id] });
      setNotice(status === "resolved" ? "问题记录已标记为已处理；这不会修改产物或自动批准版本。" : "已保存忽略理由；这不会绕过版本批准门禁。");
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "问题状态保存失败"); }
    finally { setBusy(null); }
  }
  async function startStructuredRepair() {
    if (!onStartStructuredRepair) return;
    setBusy("structured-repair"); setError(null); setNotice(null);
    try {
      await onStartStructuredRepair();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "结构化修复作业创建失败");
    } finally { setBusy(null); }
  }
  if (!open) return null;
  return <div className="af-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="af-issue-drawer" role="dialog" aria-modal="true" aria-label="问题中心">
      <header><div><span className="af-kicker">当前上下文 · {scoped.length} 项</span><h2>问题中心</h2></div><button type="button" aria-label="关闭问题中心" onClick={onClose}>关闭</button></header>
      <div className="af-issue-guidance"><div><strong>{onStartStructuredRepair ? "已把问题定位到责任产物" : "问题只作用于对应内容"}</strong><p>{onStartStructuredRepair ? `检测到 ${repairPlan?.totalIssueCount ?? scoped.length} 项阻塞问题；系统会按资产定义、导演脚本、分镜的依赖顺序逐步建立新版本，每步都等待你确认。` : "标记已处理或忽略只更新问题记录，不会改写产物、批准版本或绕过门禁。"}</p></div>{onStartStructuredRepair && <button type="button" disabled={Boolean(busy) || !repairPlan?.currentStep} onClick={() => void startStructuredRepair()}>{busy === "structured-repair" ? "正在创建…" : repairPlan?.currentStep ? `开始第 ${repairPlan.currentStep.order} 步：${repairPlan.currentStep.actionLabel}` : "正在分析问题…"}</button>}</div>
      <VerificationLedgerPanel ledger={verificationLedger ?? null} />
      {repairPlan && <section className="af-drawer-repair-plan" aria-label="责任产物修复路径"><h3>修复路径</h3><ol>{repairPlan.steps.map((step) => <li key={`${step.order}:${step.target}`}><b>{step.order}</b><div><strong>{step.label}</strong><p>{step.purpose === "repair" ? `${step.issueCount} 项直接责任问题` : "上游修复后重新生成并复检"}</p>{step.issues.map((issue, index) => <details className="af-plan-issue" key={`${issue.code}:${index}`}><summary>{issue.code}</summary><p>{issue.message}</p><small>建议：{issue.suggestedFix}</small>{issue.affectedIds.length > 0 && <small>涉及：{issue.affectedIds.join("、")}</small>}</details>)}{step.purpose === "rebuild-and-review" && step.affectedIds.length > 0 && <small>复检范围：{step.affectedIds.join("、")}</small>}</div></li>)}</ol>{repairPlan.manualIssueCodes.length > 0 && <p className="af-manual-warning">{repairPlan.manualIssueCodes.length} 项没有安全的自动改写规则，将继续保留为人工问题。</p>}</section>}
      {error && <div className="af-global-error" role="alert">{error}</div>}
      {notice && <div className="af-notice" role="status">{notice}</div>}
      {scoped.length ? scoped.map((issue) => <article key={issue.id} className={`af-issue ${issue.severity}`}>
        <div><span>{({ error: "错误", warning: "警告", info: "信息" } as const)[issue.severity]}</span><code>{issue.code}</code></div>
        <h3>{issue.title}</h3><p>{issue.detail}</p>
        {issue.suggestedAction && <small>建议：{issue.suggestedAction}</small>}
        <textarea aria-label={`${issue.title}的处理说明`} value={reasons[issue.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [issue.id]: event.target.value }))} placeholder="忽略时必须填写理由；标记已处理时可选" />
        <div className="af-issue-actions"><button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "resolved")}>{busy === issue.id ? "保存中…" : "标记已处理"}</button><button type="button" disabled={busy === issue.id || !(reasons[issue.id] ?? "").trim()} onClick={() => void update(issue, "ignored")}>记录理由并忽略</button></div>
      </article>) : <div className="af-empty"><strong>当前内容没有开放问题</strong><p>其他版本的问题仍保留在各自上下文中。</p></div>}
    </aside>
  </div>;
}
