import type { Screenplay, StoryOutline } from "../ai/text-provider";

export const GENERATION_READINESS_POLICY_VERSION = "paid-generation-readiness-v1";
export const RELIABLE_MAJOR_BEATS_PER_SHOT = 4;
export const RELIABLE_HIGH_RISK_LAYERS_PER_SHOT = 2;

export interface GenerationReadinessIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  suggestedFix: string;
}

export interface NarrativeFeasibilityReport {
  policyVersion: typeof GENERATION_READINESS_POLICY_VERSION;
  status: "ready" | "blocked";
  targetDurationSec: number;
  estimatedMajorBeats: number;
  highRiskLayers: string[];
  recommendedMinimumShots: number;
  maximumProductShots: number;
  minimumReliableDurationSec: number;
  acknowledgementRequired: boolean;
  acknowledgementReasons: string[];
  issues: GenerationReadinessIssue[];
}

const riskPatterns: Array<[string, RegExp]> = [
  ["屏幕/通话画面", /手机|屏幕|视频通话|通话画面|显示界面/u],
  ["复杂镜面/反射", /镜中|镜面|镜像|反射|镜里的/u],
  ["多主体群体", /无数|大量|挤满|群体|所有.+同时|复制体|分身|克隆/u],
  ["反常空间", /另一部完全相同|第二部.+(?:电梯|房间|空间)|直接相连|无缝相接|门外不是/u],
];

function detectRiskLayers(value: unknown): string[] {
  const text = JSON.stringify(value);
  return riskPatterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function buildReport(input: {
  targetDurationSec: number;
  estimatedMajorBeats: number;
  highRiskLayers: string[];
  minimumShotDurationSec: number;
  acknowledgementReasons: string[];
}): NarrativeFeasibilityReport {
  const maximumProductShots = Math.floor(input.targetDurationSec / input.minimumShotDurationSec);
  const beatDrivenShots = Math.ceil(input.estimatedMajorBeats / RELIABLE_MAJOR_BEATS_PER_SHOT);
  const riskDrivenShots = Math.ceil(input.highRiskLayers.length / RELIABLE_HIGH_RISK_LAYERS_PER_SHOT);
  const recommendedMinimumShots = Math.max(1, beatDrivenShots, riskDrivenShots);
  const minimumReliableDurationSec = recommendedMinimumShots * input.minimumShotDurationSec;
  const issues: GenerationReadinessIssue[] = [];

  if (maximumProductShots < 1) {
    issues.push({
      severity: "error",
      code: "NARRATIVE_TARGET_BELOW_PROVIDER_MINIMUM",
      message: `${input.targetDurationSec} 秒项目无法容纳一个至少 ${input.minimumShotDurationSec} 秒的生产镜头。`,
      suggestedFix: `把项目时长提高到至少 ${input.minimumShotDurationSec} 秒。`,
    });
  }
  if (recommendedMinimumShots > maximumProductShots) {
    issues.push({
      severity: "error",
      code: "NARRATIVE_COMPLEXITY_EXCEEDS_DURATION",
      message: `预计 ${input.estimatedMajorBeats} 个主要剧情 Beat、${input.highRiskLayers.length} 类高风险任务至少需要 ${recommendedMinimumShots} 个生产镜头，但 ${input.targetDurationSec} 秒最多只能容纳 ${maximumProductShots} 个不少于 ${input.minimumShotDurationSec} 秒的镜头。`,
      suggestedFix: `将项目时长提高到至少 ${minimumReliableDurationSec} 秒，或删减/合并剧情事件；不能依靠加长单镜头硬塞内容。`,
    });
  } else if (recommendedMinimumShots === maximumProductShots && input.estimatedMajorBeats > RELIABLE_MAJOR_BEATS_PER_SHOT) {
    issues.push({
      severity: "warning",
      code: "NARRATIVE_COMPLEXITY_AT_CAPACITY",
      message: `当前内容需要使用全部 ${maximumProductShots} 个可用镜头容量，几乎没有表演和失败容差。`,
      suggestedFix: "优先延长时长或减少一个次要事件；若保持当前方案，导演脚本不得少于建议镜头数。",
    });
  }

  return {
    policyVersion: GENERATION_READINESS_POLICY_VERSION,
    status: issues.some((issue) => issue.severity === "error") ? "blocked" : "ready",
    targetDurationSec: input.targetDurationSec,
    estimatedMajorBeats: input.estimatedMajorBeats,
    highRiskLayers: input.highRiskLayers,
    recommendedMinimumShots,
    maximumProductShots,
    minimumReliableDurationSec,
    acknowledgementRequired: input.acknowledgementReasons.length > 0,
    acknowledgementReasons: input.acknowledgementReasons,
    issues,
  };
}

export function inspectOutlineFeasibility(
  outline: StoryOutline,
  targetDurationSec: number,
  minimumShotDurationSec = 5,
): NarrativeFeasibilityReport {
  const acknowledgementReasons = [
    ...outline.proposedChanges.map((change) => `${change.change}：${change.reason}`),
    ...outline.approvalNotes.filter((note) => /确认|选择|决定|批准采用|是否/u.test(note)),
  ];
  return buildReport({
    targetDurationSec,
    estimatedMajorBeats: outline.structure.reduce((total, sequence) => total + sequence.events.length, 0),
    highRiskLayers: detectRiskLayers(outline),
    minimumShotDurationSec,
    acknowledgementReasons,
  });
}

export function inspectScreenplayFeasibility(
  screenplay: Screenplay,
  targetDurationSec: number,
  minimumShotDurationSec = 5,
): NarrativeFeasibilityReport {
  const actionBeats = screenplay.scenes.reduce((total, scene) => total + scene.action.length, 0);
  const dialogueBeats = screenplay.scenes.reduce((total, scene) => total + scene.dialogue.length, 0);
  return buildReport({
    targetDurationSec,
    estimatedMajorBeats: actionBeats + dialogueBeats,
    highRiskLayers: detectRiskLayers(screenplay),
    minimumShotDurationSec,
    acknowledgementReasons: screenplay.unresolvedQuestions,
  });
}
