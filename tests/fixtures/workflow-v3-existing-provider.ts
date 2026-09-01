import type { TextGenerationTrace, TextIntelligenceProvider } from "../../src/ai/text-provider";

function trace(route: string): TextGenerationTrace {
  return {
    provider: "test-double",
    runId: `run-${route}`,
    threadId: null,
    usage: null,
    eventTypes: [],
    schemaVersion: `${route}-v1`,
    route: [route],
    skills: [],
    completedAt: "2026-08-31T00:00:00.000Z",
  };
}

export function workflowV3ExistingGenerationProvider(): Pick<TextIntelligenceProvider,
  "generateOutline" | "generateScreenplay" | "generateAssetBible" | "generateShootingScript" | "generateStoryboard"
> {
  return {
    async generateOutline() {
      return {
        value: {
          title: "雨夜来客",
          logline: "陌生人在雨夜电梯中确认一条延迟出现的线索。",
          themes: ["身份"],
          targetDurationSec: 10,
          structure: [{ sequence: 1, heading: "进入电梯", purpose: "建立线索", events: ["人物进入电梯并发现镜面线索。"], estimatedDurationSec: 10 }],
          lockedFacts: ["线索不得提前出现"],
          proposedChanges: [],
          approvalNotes: [],
        },
        trace: trace("outline"),
      };
    },
    async generateScreenplay() {
      return {
        value: {
          title: "雨夜来客",
          version: 1,
          basedOnApprovedArtifact: "workflow-v3-outline",
          sourcePreserved: true,
          scenes: [{ sequence: 1, heading: "内景·电梯·夜", location: "旧电梯", timeOfDay: "夜", action: ["人物进入电梯并看向镜面。"], dialogue: [] }],
          unresolvedQuestions: [],
        },
        trace: trace("screenplay"),
      };
    },
    async generateAssetBible() {
      const asset = (id: "CHAR-001" | "SCENE-001", type: "character" | "scene", name: string, appearance: string) => ({
        id,
        type,
        name,
        identity: `${name}稳定身份`,
        appearance,
        designBasis: "source-grounded" as const,
        productionReady: true,
        designSummary: appearance,
        distinctiveFeatures: [appearance],
        negativeConstraints: ["不得漂移"],
        continuityRules: ["全片一致"],
        usage: ["S001", "S002"],
        sourceEvidence: ["source"],
        unknowns: [],
      });
      return {
        value: {
          assets: [asset("CHAR-001", "character", "来客", "黑色雨衣、湿发"), asset("SCENE-001", "scene", "旧电梯", "冷灰金属、右侧镜面")],
          conflicts: [],
        },
        trace: trace("asset-bible"),
      };
    },
    async generateShootingScript({ project }) {
      return {
        value: {
          schemaVersion: "shooting-script-v1" as const,
          targetDurationSec: 10,
          validationNotes: [],
          shots: [
            {
              id: "S001", projectId: project.id, sequence: 1, startTimeSec: 0, endTimeSec: 5, durationSec: 5, purpose: "建立人物",
              characterIds: ["CHAR-001"], sceneId: "SCENE-001", propIds: [], styleIds: [], shotSize: "中景",
              camera: { position: "门内正面", movement: "固定" }, action: "来客进入电梯。", dialogue: [], sound: ["雨声"],
              startState: "电梯门开启，来客在门外。", endState: "来客站在轿厢中央。", physicalPlan: null, status: "draft" as const,
            },
            {
              id: "S002", projectId: project.id, sequence: 2, startTimeSec: 5, endTimeSec: 10, durationSec: 5, purpose: "揭示线索",
              characterIds: ["CHAR-001"], sceneId: "SCENE-001", propIds: [], styleIds: [], shotSize: "近景",
              camera: { position: "左侧侧面", movement: "缓慢推近" }, action: "来客只转动眼睛看向右侧镜面。", dialogue: [], sound: ["电梯低鸣"],
              startState: "来客站在轿厢中央。", endState: "镜面线索首次可见。", physicalPlan: null, status: "draft" as const,
            },
          ],
        },
        trace: trace("shooting-script"),
      };
    },
    async generateStoryboard({ approvedShootingScript }) {
      return {
        value: {
          schemaVersion: "storyboard-v1" as const,
          shots: approvedShootingScript.shots.map((shot) => ({
            shotId: shot.id,
            startFrame: `${shot.id} 首帧`,
            endFrame: `${shot.id} 尾帧`,
            composition: `${shot.camera.position}构图`,
            motionPlan: shot.camera.movement,
            characterIds: shot.characterIds,
            sceneId: shot.sceneId,
            requiredAssetIds: [...shot.characterIds, shot.sceneId],
            continuityRisks: [],
            physicalVerification: null,
            approved: false,
          })),
          globalContinuityNotes: [],
        },
        trace: trace("storyboard"),
      };
    },
  };
}
