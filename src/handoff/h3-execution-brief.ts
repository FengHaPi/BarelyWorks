import type { Storyboard } from "../ai/text-provider";
import type { Asset, ShotSpec } from "../shared/schemas";
import { analyzeShotComplexity, type ShotComplexityReport } from "../shared/h3-executability";

export const H3_EXECUTION_BRIEF_VERSION = "h3-execution-brief-v2";

export interface H3ExecutionBrief {
  schemaVersion: typeof H3_EXECUTION_BRIEF_VERSION;
  shotId: string;
  durationSec: number;
  purpose: string;
  startState: string;
  endState: string;
  visibleBeats: Array<{ order: number; timing: string | null; action: string }>;
  dialogue: ShotSpec["dialogue"];
  soundTimeline: string[];
  cameraContinuityMode: "single-take" | "intentional-cuts";
  spaceTopology: {
    spaces: Array<{ spaceId: string; label: string }>;
    boundaries: Array<{ boundaryId: string; fromSpaceId: string; toSpaceId: string; traversalAllowed: boolean; label: string }>;
  };
  cameraPhases: Array<{
    startOffsetSec: number;
    endOffsetSec: number;
    viewpoint: string;
    screenDirection: string;
    spaceId: string;
    positionAnchor: string;
    lookAt: string;
    transitionFromPrevious: "initial" | "continuous" | "boundary-crossing" | "cut";
    boundaryId: string | null;
    transitionPath: string | null;
  }>;
  displayFacts: string[];
  reflectionFacts: string[];
  keyStateChanges: Array<{ atSec: number; result: string; noEarlyOccurrence: boolean }>;
  visualContinuity: {
    startFrame: string;
    endFrame: string;
    composition: string;
  };
  referencedAssets: Array<{
    id: string;
    type: Asset["type"];
    name: string;
    identity: string;
    fixedFeatures: string[];
    constraints: string[];
  }>;
  complexity: Omit<ShotComplexityReport, "issues">;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function splitVisibleBeats(action: string): H3ExecutionBrief["visibleBeats"] {
  const marker = /(?<!\d)(\d+(?:\.\d+)?)\s*秒/gu;
  const matches = [...action.matchAll(marker)];
  if (!matches.length) {
    return action.split(/[。；\n]+/u)
      .map(normalize)
      .filter(Boolean)
      .map((part, index) => ({ order: index + 1, timing: null, action: part }));
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? action.length;
    return {
      order: index + 1,
      timing: `${match[1]}秒`,
      action: normalize(action.slice(start + match[0].length, end).replace(/^[，,：:\s]+/u, "")),
    };
  }).filter((beat) => beat.action);
}

export function buildH3ExecutionBrief(input: {
  shot: ShotSpec;
  storyboardShot: Storyboard["shots"][number];
  assets: Asset[];
}): H3ExecutionBrief {
  const complexity = analyzeShotComplexity(input.shot);
  const blocking = complexity.issues.filter((issue) => issue.severity === "error");
  if (blocking.length) {
    throw new Error(`镜头 ${input.shot.id} 不能编译 H3 执行简报：${blocking.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
  }
  const plan = input.shot.physicalPlan;
  if (!plan) throw new Error(`镜头 ${input.shot.id} 缺少 physicalPlan，不能创建付费生成执行简报`);
  if (!plan.cameraContinuityMode || !plan.spaceTopology) {
    throw new Error(`镜头 ${input.shot.id} 缺少摄影连续模式或空间拓扑，不能创建付费生成执行简报`);
  }
  const visibleBeats = splitVisibleBeats(input.shot.action);
  if (visibleBeats.length > complexity.maximumMajorBeats) {
    throw new Error(`镜头 ${input.shot.id} 仍包含 ${visibleBeats.length} 个可见动作段，超过执行简报预算 ${complexity.maximumMajorBeats} 个`);
  }

  return {
    schemaVersion: H3_EXECUTION_BRIEF_VERSION,
    shotId: input.shot.id,
    durationSec: input.shot.durationSec,
    purpose: normalize(input.shot.purpose),
    startState: normalize(input.shot.startState),
    endState: normalize(input.shot.endState),
    visibleBeats,
    dialogue: input.shot.dialogue,
    soundTimeline: input.shot.sound.map(normalize),
    cameraContinuityMode: plan.cameraContinuityMode,
    spaceTopology: plan.spaceTopology,
    cameraPhases: plan.cameraSegments.map((segment) => ({
      startOffsetSec: segment.startOffsetSec,
      endOffsetSec: segment.endOffsetSec,
      viewpoint: segment.viewpoint,
      screenDirection: normalize(segment.screenDirection),
      spaceId: segment.spaceId as string,
      positionAnchor: normalize(segment.positionAnchor as string),
      lookAt: normalize(segment.lookAt as string),
      transitionFromPrevious: segment.transitionFromPrevious as "initial" | "continuous" | "boundary-crossing" | "cut",
      boundaryId: segment.boundaryId ?? null,
      transitionPath: segment.transitionPath ? normalize(segment.transitionPath) : null,
    })),
    displayFacts: plan.displayRelations.map((relation) => [
      `${relation.startOffsetSec}–${relation.endOffsetSec}秒`,
      `${relation.propId} ${relation.interactionMode}`,
      `屏幕朝${relation.displayFaces}`,
      relation.cameraReadable ? `摄影机通过${relation.readabilityMethod}可读` : "摄影机不可读屏",
    ].join("；")),
    reflectionFacts: plan.reflectionRelations.map((relation) => [
      `${relation.surfaceId}`,
      `${relation.normalReflectionPairs.length}组正常反射`,
      `${relation.mirrorOnlyInstanceIds.length}个仅镜内实体`,
      `${relation.realSpaceInstanceIds.length}个现实实体`,
      relation.boundaryVisibleInFrame ? "镜面边界可见" : "镜面边界不要求可见",
    ].join("；")),
    keyStateChanges: plan.timedStateGates.map((gate) => ({
      atSec: gate.startsAtOffsetSec,
      result: normalize(gate.afterState),
      noEarlyOccurrence: gate.noEarlyOccurrence,
    })),
    visualContinuity: {
      startFrame: normalize(input.storyboardShot.startFrame),
      endFrame: normalize(input.storyboardShot.endFrame),
      composition: normalize(input.storyboardShot.composition),
    },
    referencedAssets: input.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      name: asset.name,
      identity: normalize(asset.identity),
      fixedFeatures: [...new Set(asset.distinctiveFeatures.map(normalize))].slice(0, 3),
      constraints: [...new Set([...asset.continuityRules, ...asset.negativeConstraints].map(normalize))].slice(0, 3),
    })),
    complexity: {
      policyVersion: complexity.policyVersion,
      status: complexity.status,
      estimatedMajorBeats: complexity.estimatedMajorBeats,
      maximumMajorBeats: complexity.maximumMajorBeats,
      cameraPhases: complexity.cameraPhases,
      timedStateGates: complexity.timedStateGates,
      preciseTimeAnchors: complexity.preciseTimeAnchors,
      highRiskLayers: complexity.highRiskLayers,
    },
  };
}
