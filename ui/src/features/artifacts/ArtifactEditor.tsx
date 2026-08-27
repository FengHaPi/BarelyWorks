import { useEffect, useMemo, useState } from "react";
import type { ArtifactDetail, ArtifactSummary } from "../../../../src/shared/api-contracts/agent-first";
import type { ContinuityRepairPlan } from "../../../../src/shared/continuity-repair";
import type { CumulativeVerificationLedger } from "../../../../src/shared/cumulative-verification";
import { verificationBlockingChecks } from "../../../../src/shared/cumulative-verification";
import { api } from "../../api";
import { ArtifactDiff } from "./ArtifactDiff";
import { ArtifactVersionList } from "./ArtifactVersionList";

const stateLabels = { absent: "尚未创建", draft: "草稿", approved: "已批准", rejected: "已驳回", superseded: "历史版本", "needs-review": "待复核" } as const;

export function artifactApprovalBlockers(detail: {
  artifact: Pick<ArtifactDetail["artifact"], "type" | "metadata"> & { id?: string };
  issues: Array<Pick<ArtifactDetail["issues"][number], "status" | "severity" | "title" | "code">>;
}, verificationLedger?: CumulativeVerificationLedger | null): string[] {
  const blockers = detail.issues
    .filter((issue) => issue.status === "open" && issue.severity === "error")
    .map((issue) => `${issue.title}（${issue.code}）`);
  if (detail.artifact.type === "storyboard") {
    if (detail.artifact.metadata.continuityPassed !== true) blockers.push("分镜连续性检查尚未通过");
    const verification = detail.artifact.metadata.verification;
    if (!verification || typeof verification !== "object" || (verification as Record<string, unknown>).modelExecutability !== "passed") {
      blockers.push("模型可执行性检查尚未通过");
    }
  }
  if (detail.artifact.id && verificationLedger?.targetArtifactId === detail.artifact.id) {
    blockers.push(...verificationBlockingChecks(verificationLedger).map((check) => `${check.message}（${check.code}）`));
  }
  return [...new Set(blockers)];
}

export function ArtifactEditor({ projectId, label, versions, selectedId, detail, loading, onSelectVersion, onChanged, onOpenIssues, onStartStructuredRepair, repairPlan, verificationLedger }: {
  projectId: string;
  label: string;
  versions: ArtifactSummary[];
  selectedId: string | null;
  detail: ArtifactDetail | null;
  loading: boolean;
  onSelectVersion: (artifactId: string) => void;
  onChanged: () => Promise<void> | void;
  onOpenIssues?: () => void;
  onStartStructuredRepair?: () => Promise<void>;
  repairPlan?: ContinuityRepairPlan | null;
  verificationLedger?: CumulativeVerificationLedger | null;
}) {
  const [mode, setMode] = useState<"preview" | "diff">("preview");
  const [previousDetail, setPreviousDetail] = useState<ArtifactDetail | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const previous = useMemo(() => detail ? versions.find((version) => version.version < detail.artifact.version) ?? null : null, [detail, versions]);
  const approvalBlockers = detail ? artifactApprovalBlockers(detail, verificationLedger) : [];
  const latestDecision = detail?.approvals[0] ?? null;
  const continuationTarget = typeof detail?.artifact.metadata.continuityRepairNext === "string"
    ? detail.artifact.metadata.continuityRepairNext
    : null;
  const isRepairStep = detail?.artifact.metadata.origin === "continuity-targeted-repair" && Boolean(continuationTarget);
  const canContinueRepair = Boolean(isRepairStep && detail?.artifact.isHead && detail.artifact.status === "approved" && onStartStructuredRepair);
  const canStartStructuredRepair = detail?.artifact.type === "storyboard" && approvalBlockers.length > 0 && Boolean(onStartStructuredRepair);
  const initialActionLabel = repairPlan?.currentStep ? `开始第 ${repairPlan.currentStep.order} 步：${repairPlan.currentStep.actionLabel}` : "分析并开始结构化修复";
  const continuationLabel = continuationTarget === "shooting-script" ? "继续下一步：重构导演脚本" : "继续下一步：重构并复检分镜";

  useEffect(() => {
    setPreviousDetail(null);
    if (mode === "diff" && previous) {
      void api.getArtifactDetail(projectId, previous.id).then(setPreviousDetail).catch((reason) => {
        setDecisionError(reason instanceof Error ? reason.message : "上一版本载入失败");
      });
    }
  }, [mode, previous?.id, projectId]);
  useEffect(() => { setDecisionError(null); setNotice(null); }, [detail?.artifact.id]);

  if (!selectedId) return <section className="af-content-panel af-empty-artifact"><span>尚未创建</span><h2>{label}</h2><p>该资料目前没有版本，但不会被锁定。可以在右侧 Agent 中先制定创建计划。</p></section>;
  if (loading || !detail) return <section className="af-content-panel af-loading"><div className="af-spinner" /><p>正在打开版本…</p></section>;

  async function selectHead() {
    setBusy("head"); setNotice(null); setDecisionError(null);
    try { await api.selectArtifactHead(projectId, detail!.artifact.type, detail!.artifact.id); setNotice("已选择为当前 Head；下游只会显示依赖提示，不会被锁定。"); await onChanged(); }
    catch (reason) { setDecisionError(reason instanceof Error ? reason.message : "选择 Head 失败"); }
    finally { setBusy(null); }
  }
  async function decide(decision: "approved" | "rejected") {
    setBusy(decision); setNotice(null); setDecisionError(null);
    try {
      await api.decideArtifact(projectId, detail!.artifact.id, decision, comment);
      setComment("");
      setNotice(decision === "approved" ? "当前版本已批准；没有自动生成下一环节。" : "驳回意见已记录到当前版本。");
      await onChanged();
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "审批决定保存失败");
    } finally { setBusy(null); }
  }
  async function startStructuredRepair() {
    if (!onStartStructuredRepair) return;
    setBusy("repair"); setNotice(null); setDecisionError(null);
    try {
      await onStartStructuredRepair();
      setNotice("结构化修复作业已创建。右侧会显示真实进度；完成后将打开新版本，原驳回版本不会被覆盖。");
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "结构化修复作业创建失败");
    } finally { setBusy(null); }
  }

  return <section className="af-content-panel">
    <header className="af-artifact-head">
      <div>
        <span className="af-kicker">{label}</span>
        <h2>V{String(detail.artifact.version).padStart(3, "0")}</h2>
        <div className="af-chip-row">
          <span className={`af-state af-state-${detail.artifact.state}`}>{stateLabels[detail.artifact.state]}</span>
          {detail.artifact.isHead && <span className="af-chip">当前 Head</span>}
          {detail.artifact.dependencyState === "outdated" && <span className="af-chip af-chip-warning">基于旧版本</span>}
          {detail.artifact.dependencyState === "unknown" && <span className="af-chip af-chip-warning">来源待确认</span>}
        </div>
      </div>
      <div className="af-head-actions">
        <button className={mode === "preview" ? "is-active" : ""} onClick={() => setMode("preview")}>预览</button>
        <button className={mode === "diff" ? "is-active" : ""} disabled={!previous} onClick={() => setMode("diff")}>与上一版对比</button>
      </div>
    </header>
    {notice && <div className="af-notice">{notice}</div>}
    {decisionError && <div className="af-decision-error" role="alert"><strong>操作没有完成</strong><p>{decisionError}</p>{onOpenIssues && <button type="button" onClick={onOpenIssues}>查看问题中心</button>}</div>}
    {detail.artifact.status === "rejected" && <div className="af-rejection-summary" role="status">
      <div><strong>此版本已驳回</strong><p>{latestDecision?.decision === "rejected" && latestDecision.comment ? `驳回原因：${latestDecision.comment}` : "已记录驳回决定。"}</p><small>驳回只冻结并保留这一版，不会假装修改正文。需要创建新版本后重新检查和审批。</small></div>
    </div>}
    {repairPlan && detail.artifact.type === "storyboard" && <section className="af-repair-plan" aria-label="连续性修复计划">
      <header><div><strong>已定位 {repairPlan.totalIssueCount} 项阻塞问题</strong><p>系统按责任产物分步处理；每一步都会建立新版本，并等待你选择 Head 和批准。</p></div><span>{repairPlan.steps.length} 步</span></header>
      <ol>{repairPlan.steps.map((step) => <li key={`${step.order}:${step.target}`}><b>{step.order}</b><div><strong>{step.label}</strong><p>{step.purpose === "repair" ? `${step.issueCount} 项责任问题 · ${step.actionLabel}` : `承接已修复上游 · ${step.actionLabel}`}</p></div></li>)}</ol>
      {repairPlan.manualIssueCodes.length > 0 && <small>另有 {repairPlan.manualIssueCodes.length} 项无法安全自动改写，将保留为人工处理项。</small>}
    </section>}
    {isRepairStep && <section className="af-repair-next" aria-label="结构化修复下一步">
      <div><strong>跨产物修复尚未结束</strong><p>{!detail.artifact.isHead ? "先检查本版内容并选择为 Head。" : detail.artifact.status !== "approved" ? "Head 已切换；批准本版后才会开放下一步。" : "本版已成为获批 Head，可以继续生成下一环节的新版本。"}</p></div>
      {canContinueRepair && <button type="button" disabled={Boolean(busy)} onClick={() => void startStructuredRepair()}>{busy === "repair" ? "正在创建作业…" : continuationLabel}</button>}
    </section>}
    <ArtifactVersionList versions={versions} selectedId={selectedId} onSelect={onSelectVersion} />
    {detail.artifact.dependencyMessage && <div className={`af-lineage ${detail.artifact.dependencyState}`}>{detail.artifact.dependencyMessage}</div>}
    {mode === "preview" ? <article className="af-document"><pre>{detail.content}</pre></article>
      : previousDetail ? <ArtifactDiff current={detail.content} previous={previousDetail.content} currentLabel={`V${String(detail.artifact.version).padStart(3, "0")}`} previousLabel={`V${String(previousDetail.artifact.version).padStart(3, "0")}`} />
        : <div className="af-loading-inline">正在载入上一版…</div>}
    <div className="af-decision-bar">
      {approvalBlockers.length > 0 && <div className="af-approval-blockers" role="alert"><div><strong>当前版本不能批准</strong><ul>{approvalBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div><div className="af-blocker-actions">{canStartStructuredRepair && <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void startStructuredRepair()}>{busy === "repair" ? "正在创建作业…" : initialActionLabel}</button>}{onOpenIssues && <button type="button" onClick={onOpenIssues}>查看问题</button>}</div></div>}
      <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="审批意见或驳回原因（批准可选，驳回必填）" />
      <div>
        {!detail.artifact.isHead && <button disabled={Boolean(busy)} onClick={() => void selectHead()}>{busy === "head" ? "正在选择…" : "选择为 Head"}</button>}
        <button title={approvalBlockers.join("；") || undefined} disabled={Boolean(busy) || approvalBlockers.length > 0 || (detail.artifact.status === "approved" && detail.artifact.state === "approved")} onClick={() => void decide("approved")}>{busy === "approved" ? "正在批准…" : detail.artifact.status === "approved" && detail.artifact.state === "approved" ? "此版本已批准" : approvalBlockers.length ? "存在阻塞问题" : "批准此版本"}</button>
        <button className="danger" disabled={Boolean(busy) || !comment.trim() || detail.artifact.status === "rejected"} onClick={() => void decide("rejected")}>{busy === "rejected" ? "正在驳回…" : detail.artifact.status === "rejected" ? "此版本已驳回" : "驳回此版本"}</button>
      </div>
    </div>
    <details className="af-technical"><summary>来源与技术证据</summary>
      <dl><dt>Artifact ID</dt><dd>{detail.artifact.id}</dd><dt>文件</dt><dd>{detail.artifact.filePath}</dd><dt>SHA-256</dt><dd>{detail.artifact.contentHash}</dd></dl>
      <h4>输入版本</h4>{detail.inputs.length ? detail.inputs.map((edge) => <p key={`${edge.inputArtifactId}-${edge.relation}`}>{edge.inputType} V{edge.inputVersion} · {edge.relation} {edge.inputIsCurrentHead ? "· 当前 Head" : "· 历史输入"}</p>) : <p>没有可证明的上游输入。</p>}
    </details>
  </section>;
}
