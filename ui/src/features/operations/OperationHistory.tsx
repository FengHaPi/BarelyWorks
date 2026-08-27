import type { Operation } from "../../../../src/shared/api-contracts/agent-first";

export function OperationHistory({ operations, onOpen }: { operations: Operation[]; onOpen: (id: string) => void }) {
  if (!operations.length) return <p className="af-muted">还没有后台作业。</p>;
  return <div className="af-operation-history">{operations.slice(0, 12).map((operation) => <button key={operation.id} onClick={() => onOpen(operation.id)}>
    <span><strong>{operation.kind}</strong><small>{operation.phase ?? operation.status}</small></span>
    <b className={operation.status}>{operation.status}</b>
  </button>)}</div>;
}
