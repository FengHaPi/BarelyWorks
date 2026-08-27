import type { ProjectStage } from "./types";

export const projectStageOrder = [
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
] as const satisfies readonly ProjectStage[];

type MissingProjectStage = Exclude<ProjectStage, typeof projectStageOrder[number]>;
const allProjectStagesAreOrdered: MissingProjectStage extends never ? true : never = true;
void allProjectStagesAreOrdered;

const projectStageIndexes = new Map<ProjectStage, number>(
  projectStageOrder.map((stage, index) => [stage, index]),
);

export function hasReachedProjectStage(current: ProjectStage, target: ProjectStage): boolean {
  const currentIndex = projectStageIndexes.get(current);
  const targetIndex = projectStageIndexes.get(target);
  return currentIndex !== undefined && targetIndex !== undefined && currentIndex >= targetIndex;
}
