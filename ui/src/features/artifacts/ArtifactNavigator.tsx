import type { ProjectWorkspace } from "../../../../src/shared/api-contracts/agent-first";

export type WorkspaceSection = `artifact:${string}` | "generation" | "quality" | "editing";

const stateLabels = {
  absent: "尚未创建", draft: "草稿", approved: "已批准", rejected: "已驳回", superseded: "历史版本", "needs-review": "待复核",
} as const;

export function ArtifactNavigator({ workspace, selected, onSelect }: {
  workspace: ProjectWorkspace;
  selected: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}) {
  return <nav className="af-navigator" aria-label="项目资料">
    <div className="af-panel-title"><span>项目资料</span><b>{workspace.artifactGroups.filter((group) => group.head).length}/5</b></div>
    <div className="af-nav-list">
      {workspace.artifactGroups.map((group) => {
        const key = `artifact:${group.type}` as const;
        return <button key={group.type} className={selected === key ? "is-selected" : ""} onClick={() => onSelect(key)}>
          <span><strong>{group.label}</strong><small>{group.head ? `V${String(group.head.version).padStart(3, "0")}` : "—"}</small></span>
          <span className={`af-state af-state-${group.state}`}>{stateLabels[group.state]}</span>
          {group.openIssueCount > 0 && <i>{group.openIssueCount}</i>}
        </button>;
      })}
    </div>
    <div className="af-nav-divider">制作资料</div>
    <div className="af-nav-list af-resource-nav">
      <button className={selected === "generation" ? "is-selected" : ""} onClick={() => onSelect("generation")}>
        <span><strong>镜头与视频</strong><small>{workspace.resourceSummary.generations} 个生成记录</small></span>
      </button>
      <button className={selected === "quality" ? "is-selected" : ""} onClick={() => onSelect("quality")}>
        <span><strong>质检</strong><small>{workspace.resourceSummary.qualityReviews} 条记录</small></span>
      </button>
      <button className={selected === "editing" ? "is-selected" : ""} onClick={() => onSelect("editing")}>
        <span><strong>剪辑与交付</strong><small>{workspace.resourceSummary.renders} 个历史结果</small></span>
      </button>
    </div>
  </nav>;
}
