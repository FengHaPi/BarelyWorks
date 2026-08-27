import type { ArtifactType, Project, ProjectIntegrityAudit, ProjectStage } from "./types";

export type ProjectWorkbenchView = "source" | "stage" | "generation" | "quality" | "delivery";
export type ProjectStepState = "done" | "current" | "needs-update" | "future";

export interface ProjectWorkbenchStep {
  id: "source" | ArtifactType | "generation" | "quality" | "delivery";
  label: string;
  stages: ProjectStage[];
  view: ProjectWorkbenchView;
  artifactType?: ArtifactType;
}

export const projectWorkbenchSteps: ProjectWorkbenchStep[] = [
  { id: "source", label: "输入内容", stages: ["SOURCE_IMPORTED"], view: "source" },
  { id: "outline", label: "剧情大纲", stages: ["OUTLINE_REVIEW", "OUTLINE_APPROVED"], view: "stage", artifactType: "outline" },
  { id: "screenplay", label: "影视剧本", stages: ["SCREENPLAY_REVIEW", "SCREENPLAY_APPROVED"], view: "stage", artifactType: "screenplay" },
  { id: "asset-bible", label: "资产定义", stages: ["ASSET_BIBLE_REVIEW", "ASSET_BIBLE_APPROVED", "ASSETS_LOCKED"], view: "stage", artifactType: "asset-bible" },
  { id: "shooting-script", label: "导演脚本", stages: ["SHOOTING_SCRIPT_REVIEW", "SHOOTING_SCRIPT_APPROVED"], view: "stage", artifactType: "shooting-script" },
  { id: "storyboard", label: "分镜设计", stages: ["STORYBOARD_REVIEW", "STORYBOARD_APPROVED"], view: "stage", artifactType: "storyboard" },
  { id: "generation", label: "视频生成", stages: ["READY_FOR_GENERATION", "GENERATING"], view: "generation" },
  { id: "quality", label: "质量审核", stages: ["GENERATION_REVIEW"], view: "quality" },
  { id: "delivery", label: "剪辑导出", stages: ["EDITING", "FINAL_REVIEW", "DELIVERED"], view: "delivery" },
];

export function currentProjectStepIndex(stage: ProjectStage): number {
  const index = projectWorkbenchSteps.findIndex((step) => step.stages.includes(stage));
  return index < 0 ? 0 : index;
}

export function projectStepState(project: Project, stepIndex: number, integrity?: ProjectIntegrityAudit | null): ProjectStepState {
  const step = projectWorkbenchSteps[stepIndex];
  if (integrity?.issues.some((issue) => issue.stepId === step.id && issue.severity === "error")) return "needs-update";
  const firstBlockedIndex = integrity?.firstBlockedStepId
    ? projectWorkbenchSteps.findIndex((candidate) => candidate.id === integrity.firstBlockedStepId)
    : -1;
  const currentIndex = currentProjectStepIndex(project.currentStage);
  if (firstBlockedIndex >= 0 && stepIndex > firstBlockedIndex && stepIndex <= currentIndex) return "needs-update";
  if (step.stages.some((stage) => project.staleStages.includes(stage))) return "needs-update";
  if (stepIndex < currentIndex || (stepIndex === currentIndex && project.currentStage === "DELIVERED")) return "done";
  if (stepIndex === currentIndex) return "current";
  return "future";
}

export const projectStepStateLabels: Record<ProjectStepState, string> = {
  done: "可回顾",
  current: "当前工作",
  "needs-update": "需要处理",
  future: "暂无内容",
};
