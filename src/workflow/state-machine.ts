import type { ProjectStage, SourceType } from "../shared/schemas";

export const stageOrder: ProjectStage[] = [
  "SOURCE_IMPORTED",
  "OUTLINE_REVIEW",
  "OUTLINE_APPROVED",
  "SCREENPLAY_REVIEW",
  "SCREENPLAY_APPROVED",
  "ASSET_BIBLE_REVIEW",
  "ASSET_BIBLE_APPROVED",
  "SHOOTING_SCRIPT_REVIEW",
  "SHOOTING_SCRIPT_APPROVED",
  "STORYBOARD_REVIEW",
  "STORYBOARD_APPROVED",
  "ASSETS_LOCKED",
  "READY_FOR_GENERATION",
  "GENERATING",
  "GENERATION_REVIEW",
  "EDITING",
  "FINAL_REVIEW",
  "DELIVERED",
];

const transitions: Partial<Record<ProjectStage, readonly ProjectStage[]>> = {
  SOURCE_IMPORTED: ["OUTLINE_REVIEW"],
  OUTLINE_REVIEW: ["OUTLINE_APPROVED"],
  OUTLINE_APPROVED: ["SCREENPLAY_REVIEW"],
  SCREENPLAY_REVIEW: ["SCREENPLAY_APPROVED"],
  SCREENPLAY_APPROVED: ["ASSET_BIBLE_REVIEW"],
  ASSET_BIBLE_REVIEW: ["ASSET_BIBLE_APPROVED"],
  ASSET_BIBLE_APPROVED: ["SHOOTING_SCRIPT_REVIEW"],
  SHOOTING_SCRIPT_REVIEW: ["SHOOTING_SCRIPT_APPROVED"],
  SHOOTING_SCRIPT_APPROVED: ["STORYBOARD_REVIEW"],
  STORYBOARD_REVIEW: ["STORYBOARD_APPROVED"],
  STORYBOARD_APPROVED: ["ASSETS_LOCKED"],
  ASSETS_LOCKED: ["READY_FOR_GENERATION"],
  READY_FOR_GENERATION: ["GENERATING"],
  GENERATING: ["GENERATION_REVIEW"],
  GENERATION_REVIEW: ["GENERATING", "EDITING"],
  EDITING: ["FINAL_REVIEW"],
  FINAL_REVIEW: ["EDITING", "DELIVERED"],
};

export const initialStageBySourceType: Record<SourceType, ProjectStage> = {
  story: "SOURCE_IMPORTED",
  screenplay: "SCREENPLAY_REVIEW",
  "shooting-script": "SHOOTING_SCRIPT_REVIEW",
  storyboard: "STORYBOARD_REVIEW",
};

export function canTransition(from: ProjectStage, to: ProjectStage): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(from: ProjectStage, to: ProjectStage): void {
  if (!canTransition(from, to)) {
    throw new Error(`不允许从 ${from} 迁移到 ${to}`);
  }
}

export function nextStage(from: ProjectStage): ProjectStage | null {
  const allowed = transitions[from];
  return allowed?.length === 1 ? allowed[0] : null;
}

export function downstreamStages(stage: ProjectStage): ProjectStage[] {
  const index = stageOrder.indexOf(stage);
  return index < 0 ? [] : stageOrder.slice(index + 1);
}
