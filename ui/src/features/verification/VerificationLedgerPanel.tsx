import type { CumulativeVerificationLedger } from "../../../../src/shared/cumulative-verification";

const statusLabel = { healthy: "累计核查通过", blocked: "累计核查阻断", incomplete: "核查证据不完整" } as const;
const stageStatusLabel = { passed: "通过", blocked: "阻断", incomplete: "待补证", "not-applicable": "不适用" } as const;

export function VerificationLedgerPanel({ ledger, loading, error, compact = false }: {
  ledger: CumulativeVerificationLedger | null;
  loading?: boolean;
  error?: string | null;
  compact?: boolean;
}) {
  if (loading && !ledger) return <section className="af-verification-ledger loading"><span>正在从原始输入开始累计核查…</span></section>;
  if (error && !ledger) return <section className="af-verification-ledger blocked"><strong>累计核查没有完成</strong><p>{error}</p></section>;
  if (!ledger) return null;
  const problems = ledger.stages.flatMap((stage) => stage.checks.map((check) => ({ stage, check })))
    .filter(({ check }) => check.status !== "passed");
  return <section className={`af-verification-ledger ${ledger.status} ${compact ? "compact" : ""}`} aria-label="逐级累计核查">
    <header>
      <div><span className="af-kicker">从原始输入到当前环节 · {ledger.schemaVersion}</span><strong>{statusLabel[ledger.status]}</strong><p>{ledger.earliestResponsibleStage ? `最早责任环节：${ledger.stages.find((stage) => stage.id === ledger.earliestResponsibleStage)?.label ?? ledger.earliestResponsibleStage}` : "所有适用上游均有可证明证据"}</p></div>
      <span>{ledger.blockerCount} 阻断 · {ledger.incompleteCount} 待补证</span>
    </header>
    <ol className="af-verification-stages">{ledger.stages.map((stage) => <li className={stage.status} key={stage.id}><b>{stage.label}</b><span>{stageStatusLabel[stage.status]}</span></li>)}</ol>
    {!compact && problems.length > 0 && <div className="af-verification-problems">{problems.map(({ stage, check }) => {
      const detector = ledger.detectors.find((item) => item.id === check.detectorId);
      return <article key={`${stage.id}:${check.code}:${check.message}`}><div><strong>{stage.label} · {check.code}</strong><span>{check.status === "failed" ? "未通过" : "证据不完整"}</span></div><p>{check.message}</p>{check.suggestedAction && <small>下一步：{check.suggestedAction}</small>}<small>发现主体：{detector ? `${detector.name}（${detector.health === "healthy" ? "健康" : "不可用"}）` : check.detectorId}</small></article>;
    })}</div>}
    {!compact && <details className="af-verification-detectors"><summary>检查主体与健康状态</summary>{ledger.detectors.map((detector) => <p key={detector.id}><b>{detector.name}</b> · {detector.kind} · {detector.health} · {detector.skillName ?? detector.version}{detector.model ? ` · ${detector.model}` : ""}<br /><small>{detector.detail}</small></p>)}</details>}
  </section>;
}
