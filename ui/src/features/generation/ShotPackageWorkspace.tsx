import type { HistoricalSnapshot } from "../../../../src/shared/api-contracts/agent-first";

export function ShotPackageWorkspace({ snapshots }: { snapshots: HistoricalSnapshot[] }) {
  return <div className="af-snapshot-grid">{snapshots.map((snapshot) => <article key={snapshot.id} className={`af-snapshot ${snapshot.lineageState}`}>
    <header><strong>{snapshot.label}</strong><span>{snapshot.status}</span></header>
    <p>{snapshot.lineageMessage}</p>
    <small>{snapshot.sourceIds.length ? `来源 ${snapshot.sourceIds.length} 项` : "没有可证明的 artifact 来源"}</small>
  </article>)}</div>;
}
