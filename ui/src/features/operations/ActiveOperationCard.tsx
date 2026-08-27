import type { Operation } from "../../../../src/shared/api-contracts/agent-first";
import { useOperation } from "../../hooks/useOperation";

const statusLabels: Record<Operation["status"], string> = {
  queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancel_requested: "正在取消", cancelled: "已取消",
};

const kindLabels: Record<string, string> = {
  "artifact.continuity-repair": "结构化连续性修复",
};

export function ActiveOperationCard({ operationId, onTerminal }: { operationId: string; onTerminal: (operation: Operation) => void }) {
  const { operation, events, error, cancel } = useOperation(operationId, onTerminal);
  if (error) return <div className="af-operation-card failed"><strong>作业状态载入失败</strong><p>{error}</p></div>;
  if (!operation) return <div className="af-operation-card"><div className="af-spinner small" /> 正在读取作业…</div>;
  const percentage = operation.progressTotal && operation.progressCurrent != null ? Math.round(operation.progressCurrent / operation.progressTotal * 100) : null;
  const completedActions = Array.isArray(operation.resultPayload?.completedActions) ? operation.resultPayload.completedActions.filter((item): item is string => typeof item === "string") : [];
  const unexecutedActions = Array.isArray(operation.resultPayload?.unexecutedActions) ? operation.resultPayload.unexecutedActions.filter((item): item is string => typeof item === "string") : [];
  const remainingIssueCodes = Array.isArray(operation.resultPayload?.remainingIssueCodes) ? operation.resultPayload.remainingIssueCodes.filter((item): item is string => typeof item === "string") : [];
  const artifactLabel = operation.resultPayload?.artifactType === "asset-bible" ? "资产定义"
    : operation.resultPayload?.artifactType === "shooting-script" ? "导演脚本"
      : operation.resultPayload?.artifactType === "storyboard" ? "分镜设计" : "产物";
  const continuationLabel = operation.resultPayload?.continuationTarget === "shooting-script" ? "；选择为 Head 并批准后可继续重构导演脚本"
    : operation.resultPayload?.continuationTarget === "storyboard" ? "；选择为 Head 并批准后可继续重构并复检分镜" : "";
  return <div className={`af-operation-card ${operation.status}`}>
    <header><strong>{statusLabels[operation.status]}</strong><span>{kindLabels[operation.kind] ?? operation.kind}</span></header>
    <p>{operation.phase ?? "等待阶段信息"}{percentage != null ? ` · ${percentage}%` : ""}</p>
    {percentage != null && <div className="af-progress"><i style={{ width: `${percentage}%` }} /></div>}
    {operation.errorMessage && <div className="af-operation-error">{operation.errorMessage}</div>}
    {operation.status === "succeeded" && operation.resultPayload && <p className="af-operation-result">{operation.kind === "artifact.continuity-repair"
      ? `已创建${artifactLabel}${typeof operation.resultPayload.version === "number" ? ` V${String(operation.resultPayload.version).padStart(3, "0")}` : "新版本"}；Head 未改变${continuationLabel || (remainingIssueCodes.length ? `；仍有 ${remainingIssueCodes.length} 项待处理` : "；复检未发现阻塞项")}`
      : operation.resultPayload.headChanged === false ? "已创建新版本；Head 未改变" : "作业结果已写入"}</p>}
    {(completedActions.length > 0 || unexecutedActions.length > 0) && <details className="af-operation-report" open={operation.status === "failed"}>
      <summary>执行报告</summary>
      {completedActions.length > 0 && <p>已完成：{completedActions.join("；")}</p>}
      {unexecutedActions.length > 0 && <p>未执行：{unexecutedActions.join("；")}</p>}
    </details>}
    {(["queued", "running"] as Operation["status"][]).includes(operation.status) && <button className="danger" onClick={() => void cancel()}>取消作业</button>}
    <details><summary>事件记录（{events.length}）</summary>{events.slice(-12).map((event) => <p key={event.sequence}><b>{event.sequence}</b> {event.eventType}</p>)}</details>
  </div>;
}
