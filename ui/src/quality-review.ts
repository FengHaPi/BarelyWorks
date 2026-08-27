import {
  reviewDimensions,
  type QualityReviewInput,
  type ReviewDimension,
} from "./types";

export type QuickReviewIssueId =
  | "identity"
  | "costume-props"
  | "scene"
  | "action"
  | "camera"
  | "composition-direction"
  | "start-end-state"
  | "unwanted-text"
  | "picture-quality"
  | "sound-quality";

export interface QuickReviewIssue {
  id: QuickReviewIssueId;
  label: string;
  dimension: ReviewDimension;
  retryInstruction: string;
}

export const quickReviewIssues: QuickReviewIssue[] = [
  { id: "identity", label: "人物不一致", dimension: "identity", retryInstruction: "严格保持已锁定人物的面部、发型、年龄、体型与身份特征一致。" },
  { id: "costume-props", label: "服装 / 道具错误", dimension: "costume-props", retryInstruction: "严格保持服装、配饰、道具的款式、颜色、持握方式与前后状态一致。" },
  { id: "scene", label: "场景错误", dimension: "scene", retryInstruction: "重新生成时锁定既定场景、时间、光线与空间关系，不得替换环境。" },
  { id: "action", label: "动作没完成", dimension: "action", retryInstruction: "按镜头时间轴完整执行既定动作，禁止遗漏、错序或额外动作。" },
  { id: "camera", label: "运镜错误", dimension: "camera", retryInstruction: "严格执行既定机位、焦段和镜头运动，禁止擅自切镜、缩放或改变拍摄轴线。" },
  { id: "composition-direction", label: "构图 / 方向错误", dimension: "composition-direction", retryInstruction: "锁定人物朝向、画面位置、视线与空间方向，避免轴线和左右关系跳变。" },
  { id: "start-end-state", label: "起止状态不连贯", dimension: "start-end-state", retryInstruction: "严格匹配镜头规定的起始状态和结束状态，保证可与相邻镜头连续衔接。" },
  { id: "unwanted-text", label: "多余文字 / 水印", dimension: "picture-quality", retryInstruction: "画面中禁止出现任何字幕、标题、提示文字、UI、Logo、水印、乱码或其他可见文字。" },
  { id: "picture-quality", label: "画面瑕疵", dimension: "picture-quality", retryInstruction: "消除闪烁、畸变、肢体错误、穿模、重影、模糊和其他明显生成瑕疵。" },
  { id: "sound-quality", label: "声音问题", dimension: "sound-quality", retryInstruction: "修正音画不同步、杂音、爆音、错误对白和不符合场景的声音。" },
];

const issueById = new Map(quickReviewIssues.map((issue) => [issue.id, issue]));

function inspectedDimensions(failedByDimension: Map<ReviewDimension, QuickReviewIssue[]>) {
  return reviewDimensions.map((dimension) => {
    const issues = failedByDimension.get(dimension) ?? [];
    return issues.length
      ? {
          dimension,
          status: "fail" as const,
          note: issues.map((issue) => issue.label).join("、"),
          evidence: `人工观看发现：${issues.map((issue) => issue.label).join("、")}`,
        }
      : {
          dimension,
          status: "pass" as const,
          note: "快速审核未发现明显问题",
          evidence: "人工完整观看视频",
        };
  });
}

export function createEmptyQualityReview(): QualityReviewInput {
  return {
    dimensions: reviewDimensions.map((dimension) => ({
      dimension,
      status: "not-reviewed",
      note: "待人工填写",
      evidence: "尚未检查",
    })),
    decision: "manual-fix",
    summary: "等待人工观看视频后填写结论",
    conditions: [],
    retryInstructions: [],
    unverifiedClaims: [],
  };
}

export function createQuickAcceptedReview(): QualityReviewInput {
  return {
    dimensions: inspectedDimensions(new Map()),
    decision: "accepted",
    summary: "快速审核通过：人工完整观看后未发现影响使用的明显问题。",
    conditions: [],
    retryInstructions: [],
    unverifiedClaims: [],
  };
}

export function createQuickRejectedReview(issueIds: QuickReviewIssueId[], note: string): QualityReviewInput {
  const issues = [...new Set(issueIds)].map((id) => issueById.get(id)).filter((issue): issue is QuickReviewIssue => Boolean(issue));
  if (!issues.length) throw new Error("请至少选择一个问题类型");
  const failedByDimension = new Map<ReviewDimension, QuickReviewIssue[]>();
  for (const issue of issues) {
    failedByDimension.set(issue.dimension, [...(failedByDimension.get(issue.dimension) ?? []), issue]);
  }
  const trimmedNote = note.trim();
  const labels = issues.map((issue) => issue.label).join("、");
  return {
    dimensions: inspectedDimensions(failedByDimension),
    decision: "revise-prompt-retry",
    summary: `快速审核未通过：${labels}${trimmedNote ? `。补充说明：${trimmedNote}` : ""}`,
    conditions: [],
    retryInstructions: [
      ...new Set(issues.map((issue) => issue.retryInstruction)),
      ...(trimmedNote ? [`补充修复要求：${trimmedNote}`] : []),
    ],
    unverifiedClaims: [],
  };
}
