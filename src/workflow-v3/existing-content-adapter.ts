import type { TextIntelligenceProvider, TextGenerationTrace } from "../ai/text-provider";
import type { Project } from "../shared/schemas";
import { extractExplicitShotTopology, type ExplicitShotTopology } from "../shared/explicit-shot-topology";
import {
  assetBibleSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import type {
  ContentGeneratorV3,
  GeneratedContentV3,
  GenerationTraceV3,
  ProjectV3,
} from "./contracts";

type ExistingGenerationOnlyProvider = Pick<TextIntelligenceProvider,
  | "generateOutline"
  | "generateScreenplay"
  | "generateAssetBible"
  | "generateShootingScript"
  | "generateStoryboard"
>;

function traceV3(trace: TextGenerationTrace): GenerationTraceV3 {
  return {
    provider: trace.provider,
    model: trace.model,
    runId: trace.runId,
    threadId: trace.threadId,
    usage: trace.usage,
    eventTypes: [...trace.eventTypes],
    schemaVersion: trace.schemaVersion,
    route: [...trace.route],
    completedAt: trace.completedAt,
  };
}

function reference(artifact: { artifactId: string; contentHash: string; kind: string }): string {
  return `workflow-v3:${artifact.kind}:${artifact.artifactId}:${artifact.contentHash}`;
}

export class ExistingArtifactContentAdapterV3 implements ContentGeneratorV3 {
  constructor(
    private readonly provider: ExistingGenerationOnlyProvider,
    private readonly options: {
      providerName: string;
      model: string;
      durationMinSec?: number;
      durationMaxSec?: number;
      projectDirectory?: string;
      now?: () => string;
    },
  ) {}

  private project(project: ProjectV3): Project {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return {
      id: project.projectId,
      title: project.title,
      sourceType: "story",
      targetDurationSec: project.targetDurationSec,
      aspectRatio: project.aspectRatio,
      resolution: project.resolution,
      videoType: null,
      visualStyle: project.visualStyle ?? null,
      releasePlatform: null,
      targetAudience: null,
      allowStorySuggestions: true,
      // Compatibility DTO only. workflow-v3 never reads or persists these legacy fields.
      currentStage: "SOURCE_IMPORTED",
      staleStages: [],
      sourcePath: `workflow-v3://${project.projectId}/source`,
      projectDir: this.options.projectDirectory ?? `workflow-v3://${project.projectId}`,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private explicitShotTopology(sourceText: string, targetDurationSec: number): ExplicitShotTopology | null {
    const extracted = extractExplicitShotTopology(sourceText, targetDurationSec);
    if (extracted.status === "invalid") {
      throw new Error(`WORKFLOW_V3_EXPLICIT_TOPOLOGY_INVALID: ${extracted.errors.join(" | ")}`);
    }
    return extracted.topology;
  }

  async generateOutline(input: Parameters<ContentGeneratorV3["generateOutline"]>[0]) {
    const generated = await this.provider.generateOutline({ project: this.project(input.project), sourceText: input.sourceText });
    const raw = storyOutlineSchema.parse(generated.value);
    return {
      content: {
        title: raw.title,
        logline: raw.logline,
        beats: raw.structure.map((entry) => ({
          beatId: `B${String(entry.sequence).padStart(3, "0")}`,
          summary: `${entry.heading}：${entry.purpose}；${entry.events.join("；")}`,
        })),
      },
      providerPayload: raw,
      trace: traceV3(generated.trace),
    } satisfies GeneratedContentV3<Awaited<ReturnType<ContentGeneratorV3["generateOutline"]>>["content"]>;
  }

  async generateScreenplay(input: Parameters<ContentGeneratorV3["generateScreenplay"]>[0]) {
    const outline = storyOutlineSchema.parse(input.outlineProviderPayload);
    const generated = await this.provider.generateScreenplay({
      project: this.project(input.project),
      approvedOutline: outline,
      approvedOutlineRef: reference(input.outlineArtifact),
      sourceText: input.sourceText,
    });
    const raw = screenplaySchema.parse(generated.value);
    return {
      content: {
        title: raw.title,
        scenes: raw.scenes.map((scene) => ({
          sceneId: `SCENE-${String(scene.sequence).padStart(3, "0")}`,
          heading: scene.heading,
          action: scene.action,
          beatIds: [`B${String(scene.sequence).padStart(3, "0")}`],
        })),
      },
      providerPayload: raw,
      trace: traceV3(generated.trace),
    };
  }

  async generateAssetBible(input: Parameters<ContentGeneratorV3["generateAssetBible"]>[0]) {
    const screenplay = screenplaySchema.parse(input.screenplayProviderPayload);
    const explicitShotTopology = this.explicitShotTopology(input.sourceText, input.project.targetDurationSec);
    const generated = await this.provider.generateAssetBible({
      project: this.project(input.project),
      approvedScreenplay: screenplay,
      approvedScreenplayRef: reference(input.screenplayArtifact),
      sourceText: input.sourceText,
      explicitShotTopology,
      designMode: "original-proposal",
    });
    const raw = assetBibleSchema.parse(generated.value);
    return {
      content: {
        assets: raw.assets.map((asset) => ({
          assetId: asset.id,
          kind: asset.type,
          name: asset.name,
          promptFacts: [asset.identity, asset.appearance, asset.designSummary, ...asset.distinctiveFeatures].filter(Boolean),
        })),
      },
      providerPayload: raw,
      trace: traceV3(generated.trace),
    };
  }

  async generateShootingScript(input: Parameters<ContentGeneratorV3["generateShootingScript"]>[0]) {
    const screenplay = screenplaySchema.parse(input.screenplayProviderPayload);
    const assetBible = assetBibleSchema.parse(input.assetBibleProviderPayload);
    const explicitShotTopology = this.explicitShotTopology(input.sourceText, input.project.targetDurationSec);
    const durationMinSec = this.options.durationMinSec ?? 4;
    const durationMaxSec = this.options.durationMaxSec ?? 15;
    const generated = await this.provider.generateShootingScript({
      project: this.project(input.project),
      approvedScreenplay: screenplay,
      approvedScreenplayRef: reference(input.screenplayArtifact),
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: reference(input.assetBibleArtifact),
      generationConstraints: {
        provider: this.options.providerName,
        model: this.options.model,
        durationMinSec,
        durationMaxSec,
        durationStepSec: 1,
        preferredShotDurationSec: Math.min(6, durationMaxSec),
        minimumShotsForTargetDuration: Math.max(1, Math.ceil(input.project.targetDurationSec / durationMaxSec)),
        recommendedMinimumShots: Math.max(1, Math.ceil(input.project.targetDurationSec / Math.min(6, durationMaxSec))),
        maxShotsForTargetDuration: Math.max(1, Math.ceil(input.project.targetDurationSec / durationMinSec)),
        segmentationPolicy: "content-led-longest-feasible",
        avoidDurationPadding: true,
        taskGranularity: "one-shot-per-generation-task",
        maxMajorBeatsPerShot: 4,
        maxCameraPhasesPerShot: 3,
        maxTimedStateGatesPerShot: 6,
        maxHighRiskLayersPerShot: 2,
        explicitShotTopology,
      },
    });
    const raw = shootingScriptSchema.parse(generated.value);
    if (explicitShotTopology) {
      const expected = explicitShotTopology.shots.map(({ id, startTimeSec, endTimeSec, durationSec }) => ({ id, startTimeSec, endTimeSec, durationSec }));
      const actual = raw.shots.map(({ id, startTimeSec, endTimeSec, durationSec }) => ({ id, startTimeSec, endTimeSec, durationSec }));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`WORKFLOW_V3_EXPLICIT_TOPOLOGY_MISMATCH: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
    return {
      content: {
        shots: raw.shots.map((shot) => ({
          displayId: shot.id,
          sceneId: shot.sceneId,
          durationSec: shot.durationSec,
          action: shot.action,
          startState: shot.startState,
          endState: shot.endState,
          camera: { position: shot.camera.position, movement: shot.camera.movement },
          assetIds: [...new Set([...shot.characterIds, shot.sceneId, ...shot.propIds, ...shot.styleIds])],
        })),
      },
      providerPayload: raw,
      trace: traceV3(generated.trace),
    };
  }

  async generateStoryboard(input: Parameters<ContentGeneratorV3["generateStoryboard"]>[0]) {
    const shootingScript = shootingScriptSchema.parse(input.shootingScriptProviderPayload);
    const assetBible = assetBibleSchema.parse(input.assetBibleProviderPayload);
    const generated = await this.provider.generateStoryboard({
      project: this.project(input.project),
      approvedShootingScript: shootingScript,
      approvedShootingScriptRef: reference(input.shootingScriptArtifact),
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: reference(input.assetBibleArtifact),
    });
    const raw = storyboardSchema.parse(generated.value);
    return {
      content: {
        frames: raw.shots.map((shot) => ({
          displayId: shot.shotId,
          startFrame: shot.startFrame,
          endFrame: shot.endFrame,
          composition: shot.composition,
          motion: shot.motionPlan,
        })),
      },
      providerPayload: raw,
      trace: traceV3(generated.trace),
    };
  }
}
