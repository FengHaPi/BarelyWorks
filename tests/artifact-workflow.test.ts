import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server";
import type { TextGenerationTrace, TextIntelligenceProvider } from "../src/ai/text-provider";
import type { StudioSkillName } from "../src/skills/skill-registry";
import type { MediaToolchain } from "../src/media/media-toolchain";
import { MIRROR_PARITY_CONTINUITY_RULE } from "../src/projects/project-service";
import { referencePngBase64 } from "./fixtures/reference-image";

const temporaryRoots: string[] = [];
const fakeSha256 = "a".repeat(64);
const fakeMediaToolchain: MediaToolchain = {
  async getStatus() {
    return {
      ffmpegAvailable: true,
      ffprobeAvailable: true,
      libx264Available: true,
      aacAvailable: true,
      roughCutReady: true,
      ffmpegVersion: "ffmpeg test-double",
      ffprobeVersion: "ffprobe test-double",
      ffmpegPath: "test-ffmpeg",
      ffprobePath: "test-ffprobe",
      setupDirectory: "test-tools/ffmpeg/bin",
    };
  },
  async probe(filePath) {
    const stat = await fs.stat(filePath);
    return {
      durationSec: 15,
      width: 1280,
      height: 720,
      frameRate: 24,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      formatName: "mov,mp4",
      sizeBytes: stat.size,
    };
  },
  async extractReviewFrames(request) {
    await fs.mkdir(request.outputDirectory, { recursive: true });
    const outputs = [1, 2, 3].map((index) => path.join(request.outputDirectory, `frame-${String(index).padStart(2, "0")}.jpg`));
    await Promise.all(outputs.map((output) => fs.writeFile(output, "fake review frame", { encoding: "utf8", flag: "w" })));
    return outputs;
  },
  async renderRoughCut(request) {
    await fs.writeFile(request.outputPath, "fake rough cut", { encoding: "utf8", flag: "wx" });
    await fs.writeFile(request.logPath, "fake ffmpeg completed", { encoding: "utf8", flag: "wx" });
  },
};

function fakeTrace(specialist: Exclude<StudioSkillName, "ai-video-producer" | "project-intake">, schemaVersion: string): TextGenerationTrace {
  const skillNames: StudioSkillName[] = ["ai-video-producer", specialist];
  return {
    provider: "test-double" as const,
    runId: `test-${specialist}`,
    threadId: null,
    usage: null,
    eventTypes: ["test.completed"],
    schemaVersion,
    route: ["ai-video-producer", specialist],
    skills: skillNames.map((name) => ({
      name,
      version: "0.1.1",
      sha256: fakeSha256,
      sourceFiles: ["SKILL.md", "references/output-contract.md"],
    })),
    completedAt: "2026-08-25T00:00:00.000Z",
  };
}

const fakeProvider: TextIntelligenceProvider = {
  async generateOutline({ project }) {
    return { value: {
      title: project.title,
      logline: "一个雨夜来客面对不可能出现的影子。",
      themes: ["未知", "等待"],
      targetDurationSec: project.targetDurationSec,
      structure: [{ sequence: 1, heading: "来客", purpose: "建立悬念", events: ["剑客进入", "影子出现"], estimatedDurationSec: project.targetDurationSec }],
      lockedFacts: ["油灯自行亮起", "结尾画面熄灭"],
      proposedChanges: [],
      approvalNotes: ["须人工批准"],
    }, trace: fakeTrace("story-architect", "story-architect-v1") };
  },
  async generateScreenplay({ project, approvedOutlineRef }) {
    return { value: {
      title: project.title,
      version: 1,
      basedOnApprovedArtifact: approvedOutlineRef,
      sourcePreserved: true,
      scenes: [{ sequence: 1, heading: "内景 客栈 夜", location: "客栈", timeOfDay: "夜", action: ["剑客进入，油灯亮起。"], dialogue: [{ speaker: "低语", text: "你终于来了。" }] }],
      unresolvedQuestions: [],
    }, trace: fakeTrace("screenplay-writer", "screenplay-writer-v1") };
  },
  async generateAssetBible() {
    return { value: {
      assets: [
        { id: "CHAR-001", type: "character" as const, name: "剑客", identity: "进入客栈的黑衣剑客", appearance: "高瘦青年剑客，黑色窄袖长衣、深灰绑腿与旧皮剑鞘，束起长发，左眉有短疤，动作克制警觉。", designBasis: "creative-proposal" as const, productionReady: true, designSummary: "冷灰雨夜中的高瘦黑衣剑客，以窄袖轮廓、旧剑鞘和左眉短疤固定身份。", distinctiveFeatures: ["高束长发", "左眉短疤", "旧皮剑鞘"], negativeConstraints: ["不得更换黑色窄袖长衣", "不得移除左眉短疤"], continuityRules: ["始终穿黑衣"], usage: ["S001"], sourceEvidence: ["剧本第一场"], unknowns: [] },
        { id: "SCENE-001", type: "scene" as const, name: "客栈", identity: "雨夜客栈内景", appearance: "狭长木结构客栈内景，右侧旧木柜台，中央三张方桌，暖色油灯照亮湿润门槛，窗外持续冷蓝雨幕。", designBasis: "creative-proposal" as const, productionReady: true, designSummary: "冷蓝雨幕包围的狭长木客栈，以右侧柜台、中央方桌和暖色油灯建立稳定空间。", distinctiveFeatures: ["右侧旧木柜台", "中央三张方桌", "冷蓝雨幕与暖灯对比"], negativeConstraints: ["不得改变门、柜台和方桌的相对位置"], continuityRules: ["保持夜景"], usage: ["S001"], sourceEvidence: ["内景 客栈 夜"], unknowns: [] },
        { id: "STYLE-001", type: "style" as const, name: "冷灰电影感", identity: "全片统一视觉风格", appearance: "低饱和冷灰主色，雨夜环境使用冷蓝阴影，人物和油灯保留克制暖色轮廓光，画面具有细颗粒和柔和高光。", designBasis: "source-grounded" as const, productionReady: true, designSummary: "低饱和冷灰电影感，冷蓝雨夜与克制暖色油灯形成统一色彩关系。", distinctiveFeatures: ["低饱和冷灰", "冷蓝阴影", "暖色轮廓光"], negativeConstraints: ["不得切换为高饱和卡通色彩"], continuityRules: ["统一色调"], usage: ["S001"], sourceEvidence: ["项目视觉风格"], unknowns: [] },
      ],
      conflicts: [],
    }, trace: fakeTrace("asset-bible-builder", "asset-bible-builder-v1") };
  },
  async generateAssetReferencePrompt({ asset, role }) {
    return { value: {
      schemaVersion: "asset-reference-prompt-v1" as const,
      assetId: asset.id,
      role,
      promptZh: `${asset.name}的${role}参考图，${asset.appearance}。保持${asset.distinctiveFeatures.join("、")}，采用干净中性背景，完整呈现可制作造型、材质、色板与身份特征，画面中不得添加无关人物、文字、标志或水印。`,
      promptEn: `${role} reference image for ${asset.name}. ${asset.appearance} Preserve the fixed identity, silhouette, materials, palette, and the following distinctive features: ${asset.distinctiveFeatures.join(", ")}. Use a clean neutral background with no unrelated people, text, logos, or watermarks.`,
      negativePrompt: `禁止身份漂移、文字、水印、无关人物；${asset.negativeConstraints.join("；")}`,
      compositionNotes: [`清楚呈现${role}构图`],
      continuityLocks: asset.distinctiveFeatures.slice(0, 2),
    }, trace: fakeTrace("asset-reference-prompt-writer", "asset-reference-prompt-v1") };
  },
  async generateShootingScript({ project }) {
    return { value: {
      schemaVersion: "shooting-script-v1" as const,
      targetDurationSec: project.targetDurationSec,
      shots: [{
        id: "S001", projectId: project.id, sequence: 1, startTimeSec: 0, endTimeSec: project.targetDurationSec,
        durationSec: project.targetDurationSec, purpose: "建立悬念", characterIds: ["CHAR-001"], sceneId: "SCENE-001",
        propIds: [], styleIds: ["STYLE-001"], shotSize: "全景至中景", camera: { position: "门内平视", movement: "缓慢推进", lens: "35mm", composition: "人物居左" },
        action: "剑客进入，油灯自行亮起。", dialogue: [], sound: ["雨声"], startState: "客栈空镜", endState: "剑客站在门内", physicalPlan: null, preferredProvider: null, status: "draft" as const,
      }],
      validationNotes: [],
    }, trace: fakeTrace("shooting-script-director", "shooting-script-director-v1") };
  },
  async generateStoryboard() {
    return { value: {
      schemaVersion: "storyboard-v1" as const,
      shots: [{ shotId: "S001", startFrame: "客栈空镜", endFrame: "剑客站在门内", composition: "人物居左，油灯居右", motionPlan: "缓慢推进", characterIds: ["CHAR-001"], sceneId: "SCENE-001", requiredAssetIds: ["CHAR-001", "SCENE-001", "STYLE-001"], continuityRisks: [], physicalVerification: null, approved: false }],
      globalContinuityNotes: ["保持冷灰夜景"],
    }, trace: fakeTrace("storyboard-director", "storyboard-director-v1") };
  },
  async reviewContinuity() {
    return { value: { checkedShotIds: ["S001"], issues: [], passed: true, uncheckedClaims: ["尚无生成视频"] }, trace: fakeTrace("continuity-supervisor", "continuity-supervisor-v1") };
  },
  async generateH3Prompt(input) {
    return {
      value: {
        mode: input.mode,
        prompt: input.mode === "Ref2VA"
          ? `subject_definitions:\n${input.referenceLabels.map((item) => `${item.label} 是已批准的 ${item.assetId} 身份参考。`).join("\n")}\n\nsummary:\n[reference generation] 已批准镜头准备就绪。\n\nretention_analysis:\n${input.referenceLabels.map((item) => `${item.label}: fully_preserved - 保持已批准身份。`).join("\n")}\n\ndetailed_description:\n[Shot 1] 写实电影感，在一个连续镜头中完成已批准动作。\n\noverall_soundscape:\n稳定雨声与室内环境底噪。\n\nnon_diegetic_music:\nN/A`
          : "integrated_multimodal_description: [Shot 1] 写实电影感，黑衣剑客进入昏暗客栈，镜头缓慢推进。\n\noverall_soundscape: 稳定雨声与安静室内底噪。\n\nnon_diegetic_music: N/A",
        referenceLabels: input.referenceLabels,
        notes: [],
      },
      trace: {
        provider: "test-double" as const,
        runId: "test-h3",
        threadId: null,
        usage: null,
        eventTypes: ["test.completed"],
        schemaVersion: "h3-prompt-v1",
        route: ["h3-prompt-writing"],
        skills: [{ name: "h3-prompt-writing", version: "main@test", sha256: fakeSha256, sourceFiles: ["SKILL.md", "references/base-en.txt", "references/ref-en.txt"] }],
        completedAt: "2026-08-25T00:00:00.000Z",
      },
    };
  },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createStoryApp(textProvider: TextIntelligenceProvider = fakeProvider) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-artifacts-"));
  temporaryRoots.push(runtimeRoot);
  await Promise.all([
    fs.cp(path.join(process.cwd(), "configs"), path.join(runtimeRoot, "configs"), { recursive: true }),
    fs.cp(path.join(process.cwd(), "provider-skills"), path.join(runtimeRoot, "provider-skills"), { recursive: true }),
    fs.cp(path.join(process.cwd(), "skills"), path.join(runtimeRoot, "skills"), { recursive: true }),
    fs.cp(path.join(process.cwd(), ".codex-plugin"), path.join(runtimeRoot, ".codex-plugin"), { recursive: true }),
  ]);
  const app = await createApp({ runtimeRoot, logger: false, textProvider, mediaToolchain: fakeMediaToolchain });
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      title: "雨夜来客",
      sourceType: "story",
      sourceText: "黑衣剑客进入客栈，油灯自行亮起。",
      targetDurationSec: 15,
      aspectRatio: "16:9",
      resolution: "1280x720",
      videoType: "叙事短片",
      visualStyle: "冷灰电影感",
      releasePlatform: "",
      targetAudience: "",
      allowStorySuggestions: true,
    },
  });
  return { app, runtimeRoot, project: response.json().project as { id: string; projectDir: string } };
}

async function waitForOperation(app: Awaited<ReturnType<typeof createApp>>, operationId: string) {
  const started = Date.now();
  for (;;) {
    const response = await app.inject({ method: "GET", url: `/api/operations/${operationId}` });
    const operation = response.json().operation;
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) return operation;
    if (Date.now() - started > 3_000) throw new Error("等待 operation 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("versioned text workflow", () => {
  it("revises the paid-generation duration while preserving and invalidating existing history", async () => {
    const { app, project } = await createStoryApp();
    const outlineResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    expect(outlineResult.statusCode).toBe(201);

    const revised = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/production-constraints`,
      payload: { targetDurationSec: 25 },
    });

    expect(revised.statusCode).toBe(200);
    expect(revised.json().project).toMatchObject({
      targetDurationSec: 25,
      currentStage: "SOURCE_IMPORTED",
    });
    expect(revised.json().project.staleStages).toContain("OUTLINE_REVIEW");
    const outlineHistory = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/outline` });
    expect(outlineHistory.json().artifacts).toHaveLength(1);
    expect(outlineHistory.json().artifacts[0]).toMatchObject({ version: 1, status: "stale" });
    await app.close();
  });

  it("exposes approved-screenplay readiness before the generation center attempts a rebuild", async () => {
    const { app, project } = await createStoryApp();
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });

    const readiness = await app.inject({ method: "GET", url: `/api/projects/${project.id}/generation-readiness` });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().readiness).toMatchObject({
      targetDurationSec: 15,
      status: "ready",
      maximumProductShots: 3,
    });
    await app.close();
  });

  it("blocks screenplay generation before the outline approval gate", async () => {
    const { app, project } = await createStoryApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/先批准剧情大纲/);
    await app.close();
  });

  it("rejects generated shooting scripts that still violate the integer five-second policy after correction", async () => {
    let receivedGenerationConstraints: Parameters<TextIntelligenceProvider["generateShootingScript"]>[0]["generationConstraints"] | null = null;
    const incompatibleProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateShootingScript(input) {
        receivedGenerationConstraints = input.generationConstraints;
        const generated = await fakeProvider.generateShootingScript(input);
        const template = generated.value.shots[0];
        return {
          ...generated,
          value: {
            ...generated.value,
            shots: Array.from({ length: 5 }, (_, index) => ({
              ...template,
              id: `S${String(index + 1).padStart(3, "0")}`,
              sequence: index + 1,
              startTimeSec: index * 3,
              endTimeSec: (index + 1) * 3,
              durationSec: 3,
            })),
          },
        };
      },
    };
    const { app, project } = await createStoryApp(incompatibleProvider);
    const outlineResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outlineResult.json().artifact.id } });
    const screenplayResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplayResult.json().artifact.id } });
    const assetResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetResult.json().artifact.id } });
    const shootingResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` });
    expect(receivedGenerationConstraints).toMatchObject({
      durationMinSec: 5,
      durationMaxSec: 15,
      durationStepSec: 1,
      preferredShotDurationSec: 15,
      minimumShotsForTargetDuration: 1,
      maxShotsForTargetDuration: 3,
      segmentationPolicy: "content-led-longest-feasible",
      avoidDurationPadding: true,
    });

    expect(shootingResult.statusCode).toBe(400);
    expect(shootingResult.json().message).toMatch(/内部三次生成.*SHOT_DURATION_BELOW_PRODUCT_MIN/);
    await app.close();
  });

  it("blocks a conflicting style aspect ratio at the asset approval gate", async () => {
    const conflictingAspectProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateAssetBible(input) {
        const generated = await fakeProvider.generateAssetBible(input);
        return {
          ...generated,
          value: {
            ...generated.value,
            assets: generated.value.assets.map((asset) => asset.id === "STYLE-001" ? {
              ...asset,
              appearance: "9:16 竖幅写实电影风格，低饱和冷灰主色，冷蓝雨夜与克制暖色油灯形成统一视觉关系。",
              continuityRules: ["全片维持 9:16 竖幅与统一冷灰色调"],
            } : asset),
          },
        };
      },
    };
    const { app, project } = await createStoryApp(conflictingAspectProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    const assetBible = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` })).json().artifact;

    const readiness = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets/readiness` });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().passed).toBe(false);
    expect(readiness.json().issues.join("；")).toContain("STYLE-001");

    const approval = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`,
      payload: { artifactId: assetBible.id },
    });

    expect(approval.statusCode).toBe(400);
    expect(approval.json().message).toContain("STYLE-001");
    expect(approval.json().message).toContain("9:16");
    expect(approval.json().message).toContain("16:9");
    await app.close();
  });

  it("does not treat character-sheet framing or negative constraints as final-frame declarations", async () => {
    const referenceFramingProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateAssetBible(input) {
        const generated = await fakeProvider.generateAssetBible(input);
        return {
          ...generated,
          value: {
            ...generated.value,
            assets: generated.value.assets.map((asset) => asset.id === "CHAR-001"
              ? { ...asset, appearance: `1:1 方形人物设定图。${asset.appearance}` }
              : asset.id === "STYLE-001"
                ? { ...asset, negativeConstraints: [...asset.negativeConstraints, "不得裁成9:16竖幅"] }
                : asset),
          },
        };
      },
    };
    const { app, project } = await createStoryApp(referenceFramingProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });

    const readiness = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets/readiness` });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ passed: true, issues: [] });
    await app.close();
  });

  it("blocks placeholder asset approval and accepts a measured local reference image", async () => {
    let receivedDesignMode: string | null = null;
    const placeholderProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateAssetBible(input) {
        receivedDesignMode = input.designMode;
        const generated = await fakeProvider.generateAssetBible(input);
        return {
          ...generated,
          value: {
            ...generated.value,
            assets: [...generated.value.assets.map((asset) => asset.id === "CHAR-001" ? {
              ...asset,
              appearance: "具体颜色及其他外貌尚未确定。",
              designBasis: "source-grounded" as const,
              productionReady: false,
              designSummary: "",
              distinctiveFeatures: [],
              negativeConstraints: [],
              unknowns: ["服装、发型、面部与体型尚未确定"],
            } : asset), {
              id: "AUDIO-001",
              type: "audio" as const,
              name: "雨夜环境声",
              identity: "贯穿客栈场景的雨夜环境声",
              appearance: "稳定雨声与室内木结构低频共鸣",
              designBasis: "source-grounded" as const,
              productionReady: true,
              designSummary: "持续雨声用于建立夜间空间，不作为视觉参考。",
              distinctiveFeatures: ["稳定雨声", "室内低频共鸣"],
              negativeConstraints: ["不得加入画外对白"],
              continuityRules: ["全镜头保持雨声底噪"],
              usage: ["S001"],
              sourceEvidence: ["导演脚本雨声"],
              unknowns: [],
            }],
          },
        };
      },
    };
    const { app, project } = await createStoryApp(placeholderProvider);
    const outlineResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outlineResult.json().artifact.id } });
    const screenplayResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplayResult.json().artifact.id } });
    const assetResult = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/asset-bible/generate`,
      payload: { designMode: "reference-first" },
    });
    expect(receivedDesignMode).toBe("reference-first");

    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`,
      payload: { artifactId: assetResult.json().artifact.id },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/CHAR-001.*尚未形成可制作视觉设定/);

    const rejectedAudioImage = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/AUDIO-001/references`,
      payload: {
        fileName: "not-audio-reference.png",
        mimeType: "image/png",
        dataBase64: referencePngBase64,
        role: "主参考",
        authorizationConfirmed: true,
      },
    });
    expect(rejectedAudioImage.statusCode).toBe(400);
    expect(rejectedAudioImage.json().message).toMatch(/不支持图片参考/);

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/references`,
      payload: {
        fileName: "character.png",
        mimeType: "image/png",
        dataBase64: referencePngBase64,
        role: "主参考",
        authorizationConfirmed: true,
      },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().asset).toMatchObject({ designBasis: "reference-guided", productionReady: true, fileRoles: ["主参考"], authorizationState: "confirmed" });
    expect(uploaded.json().asset.sha256[0]).toMatch(/^[a-f0-9]{64}$/);
    const firstReferencePath = uploaded.json().asset.localFiles[0] as string;
    expect(path.basename(firstReferencePath)).toMatch(/^CHAR-001_剑客_主参考_V001_01_[a-f0-9]{8}\.png$/);
    const preview = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets/CHAR-001/references/0` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("image/png");

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/assets/CHAR-001/references/0`,
      payload: {
        fileName: "character-replacement.png",
        mimeType: "image/png",
        dataBase64: referencePngBase64,
        authorizationConfirmed: true,
      },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().asset.localFiles).toHaveLength(1);
    expect(replaced.json().asset.localFiles[0]).not.toBe(firstReferencePath);
    expect(path.basename(replaced.json().asset.localFiles[0])).toMatch(/^CHAR-001_剑客_主参考_V001_01_[a-f0-9]{8}\.png$/);
    expect(replaced.json().asset.fileRoles).toEqual(["主参考"]);
    await expect(fs.access(firstReferencePath)).rejects.toThrow();

    const removed = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/assets/CHAR-001/references/0` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().asset).toMatchObject({
      localFiles: [],
      sha256: [],
      fileRoles: [],
      productionReady: false,
      designBasis: "source-grounded",
      designSummary: "",
      referenceBaseline: null,
    });
    const removedPreview = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets/CHAR-001/references/0` });
    expect(removedPreview.statusCode).toBe(400);
    const archivedFiles = await fs.readdir(path.join(project.projectDir, "history", "reference-images", "CHAR-001", "v001"));
    expect(archivedFiles).toHaveLength(2);

    const blockedAfterRemoval = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`,
      payload: { artifactId: assetResult.json().artifact.id },
    });
    expect(blockedAfterRemoval.statusCode).toBe(400);
    expect(blockedAfterRemoval.json().message).toMatch(/CHAR-001.*尚未形成可制作视觉设定/);

    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/references`,
      payload: {
        fileName: "character-final.png",
        mimeType: "image/png",
        dataBase64: referencePngBase64,
        role: "主参考",
        authorizationConfirmed: true,
      },
    });
    expect(restored.statusCode).toBe(201);

    const approved = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`,
      payload: { artifactId: assetResult.json().artifact.id },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().project.currentStage).toBe("ASSET_BIBLE_APPROVED");
    await app.close();
  });

  it("generates and versions an asset reference prompt while keeping the paid image provider disabled", async () => {
    const { app, project } = await createStoryApp();
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });

    const promptResult = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/reference-prompts`,
      payload: { role: "主参考" },
    });
    expect(promptResult.statusCode).toBe(201);
    expect(promptResult.json().prompt).toMatchObject({
      assetId: "CHAR-001",
      role: "主参考",
      version: 1,
      provider: "test-double",
    });
    expect(promptResult.json().asset.referencePrompts).toHaveLength(1);
    expect(promptResult.json().imageProvider).toMatchObject({ configured: false, enabled: false, requiresPayment: true });

    const promptFiles = await fs.readdir(path.join(project.projectDir, "prompts", "assets", "CHAR-001", "v001"));
    expect(promptFiles).toEqual(["prompt-v001.json"]);

    const imageResult = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/reference-images/generate`,
      payload: { promptId: promptResult.json().prompt.id },
    });
    expect(imageResult.statusCode).toBe(400);
    expect(imageResult.json().message).toMatch(/尚未配置图像生成 Provider|尚未配置图像生成/);
    const assets = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets` })).json().assets;
    expect(assets.find((asset: { id: string }) => asset.id === "CHAR-001").localFiles).toEqual([]);
    await app.close();
  });

  it("projects only the latest asset-bible members and preserves their local references", async () => {
    let assetBibleRuns = 0;
    const changingAssetProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateAssetBible(input) {
        const generated = await fakeProvider.generateAssetBible(input);
        assetBibleRuns += 1;
        return assetBibleRuns === 1
          ? {
              ...generated,
              value: {
                ...generated.value,
                assets: [...generated.value.assets, {
                  ...generated.value.assets[0],
                  id: "PROP-999",
                  type: "prop" as const,
                  name: "旧版临时道具",
                  identity: "只存在于第一版资产定义的临时道具",
                }],
              },
            }
          : generated;
      },
    };
    const { app, project } = await createStoryApp(changingAssetProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });

    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/references`,
      payload: {
        fileName: "character.png",
        mimeType: "image/png",
        dataBase64: referencePngBase64,
        role: "主参考",
        authorizationConfirmed: true,
      },
    });
    expect(upload.statusCode, upload.body).toBe(201);

    const second = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });
    expect(second.statusCode, second.body).toBe(201);
    const assets = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets` })).json().assets;
    expect(assets.map((asset: { id: string }) => asset.id)).toEqual(["CHAR-001", "SCENE-001", "STYLE-001"]);
    expect(assets.find((asset: { id: string }) => asset.id === "CHAR-001")).toMatchObject({
      authorizationState: "confirmed",
      designBasis: "reference-guided",
      fileRoles: ["主参考"],
      productionReady: true,
    });
    expect(assets.find((asset: { id: string; localFiles: string[] }) => asset.id === "CHAR-001").localFiles).toHaveLength(1);

    const removedAssetWrite = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/PROP-999/references`,
      payload: { fileName: "removed.png", mimeType: "image/png", dataBase64: referencePngBase64, role: "其他", authorizationConfirmed: true },
    });
    expect(removedAssetWrite.statusCode).toBe(400);
    expect(removedAssetWrite.json().message).toMatch(/当前资产定义版本/);

    const identityChangingProvider = changingAssetProvider.generateAssetBible;
    changingAssetProvider.generateAssetBible = async (input) => {
      const generated = await identityChangingProvider.call(changingAssetProvider, input);
      return {
        ...generated,
        value: {
          ...generated.value,
          assets: generated.value.assets.map((asset) => asset.id === "CHAR-001"
            ? { ...asset, appearance: `${asset.appearance} 身份造型已改为银色短发与白色长衣。` }
            : asset),
        },
      };
    };
    const third = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });
    expect(third.statusCode, third.body).toBe(201);
    const reboundAssets = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets` })).json().assets;
    expect(reboundAssets.find((asset: { id: string }) => asset.id === "CHAR-001")).toMatchObject({
      authorizationState: "unknown",
      localFiles: [],
      fileRoles: [],
    });
    await app.close();
  });

  it("can rebuild assets from a later stage while preserving stale downstream history", async () => {
    let assetGeneration = 0;
    const revisionProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateAssetBible(input) {
        assetGeneration += 1;
        const generated = await fakeProvider.generateAssetBible(input);
        return {
          ...generated,
          value: {
            ...generated.value,
            assets: generated.value.assets.map((asset) => ({ ...asset, designSummary: `${asset.designSummary} 资产方案版本 ${assetGeneration}。` })),
          },
        };
      },
    };
    const { app, project } = await createStoryApp(revisionProvider);
    const outlineResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outlineResult.json().artifact.id } });
    const screenplayResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplayResult.json().artifact.id } });
    const firstAssets = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate`, payload: { designMode: "original-proposal" } });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: firstAssets.json().artifact.id } });
    const shooting = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` });
    expect(shooting.json().project.currentStage).toBe("SHOOTING_SCRIPT_REVIEW");

    const rebuilt = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate`, payload: { designMode: "original-proposal" } });
    expect(rebuilt.statusCode).toBe(201);
    expect(rebuilt.json().artifact.version).toBe(2);
    expect(rebuilt.json().project.currentStage).toBe("ASSET_BIBLE_REVIEW");
    expect(rebuilt.json().project.staleStages).toContain("SHOOTING_SCRIPT_REVIEW");
    const shootingHistory = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/shooting-script` });
    expect(shootingHistory.json().artifacts[0].status).toBe("stale");
    await app.close();
  });

  it("locks a rejected version until a new version is created", async () => {
    const { app, project } = await createStoryApp();
    const generated = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    const first = generated.json().artifact as { id: string; content: string };

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/outline`,
      payload: { content: first.content, sourceArtifactId: first.id, expectedLatestArtifactId: first.id },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toMatch(/未创建重复版本/);

    const missingComment = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/reject`,
      payload: { artifactId: first.id },
    });
    expect(missingComment.statusCode).toBe(400);
    expect(missingComment.json().message).toMatch(/必须填写修改意见/);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/reject`,
      payload: { artifactId: first.id, comment: "需要加强结尾悬念" },
    });
    expect(rejected.statusCode).toBe(200);
    const listAfterReject = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/outline` });
    expect(listAfterReject.json().artifacts[0].status).toBe("rejected");

    const approveRejected = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`,
      payload: { artifactId: first.id },
    });
    expect(approveRejected.statusCode).toBe(400);
    expect(approveRejected.json().message).toMatch(/必须修改或重新生成新版本/);

    const revised = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/outline`,
      payload: { content: `${first.content}\n\n加强后的结尾悬念。`, sourceArtifactId: first.id, expectedLatestArtifactId: first.id },
    });
    const second = revised.json().artifact as { id: string; version: number };
    expect(second.version).toBe(2);
    const approveSecond = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`,
      payload: { artifactId: second.id, comment: "人工确认修改后的大纲版本" },
    });
    expect(approveSecond.statusCode).toBe(200);
    expect(approveSecond.json().project.currentStage).toBe("OUTLINE_APPROVED");
    await app.close();
  });

  it("persists versions, binds approval hashes, and invalidates downstream work", async () => {
    const { app, runtimeRoot, project } = await createStoryApp();
    const outlineResponse = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    expect(outlineResponse.statusCode).toBe(201);
    const outline = outlineResponse.json().artifact as { id: string; filePath: string; content: string; version: number; metadata: Record<string, unknown> };
    expect(outline.version).toBe(1);
    expect(await fs.readFile(outline.filePath, "utf8")).toBe(outline.content);
    expect(outline.metadata.route).toEqual(["ai-video-producer", "story-architect"]);
    expect(outline.metadata.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "story-architect", version: "0.1.1", sha256: fakeSha256 }),
    ]));

    const approveOutline = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`,
      payload: { artifactId: outline.id, comment: "测试批准" },
    });
    expect(approveOutline.statusCode).toBe(200);
    expect(approveOutline.json().project.currentStage).toBe("OUTLINE_APPROVED");
    expect(approveOutline.json().approval.artifactHash).toBe(createHash("sha256").update(outline.content).digest("hex"));

    const screenplayResponse = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    const screenplay = screenplayResponse.json().artifact as { id: string };
    expect(screenplayResponse.json().project.currentStage).toBe("SCREENPLAY_REVIEW");
    const approveScreenplay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`,
      payload: { artifactId: screenplay.id },
    });
    expect(approveScreenplay.json().project.currentStage).toBe("SCREENPLAY_APPROVED");

    const revisedOutline = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/outline`,
      payload: { content: `${outline.content}\n\n人工补充说明。`, sourceArtifactId: outline.id, expectedLatestArtifactId: outline.id },
    });
    expect(revisedOutline.statusCode).toBe(201);
    expect(revisedOutline.json().artifact.version).toBe(2);
    expect(revisedOutline.json().project.currentStage).toBe("OUTLINE_REVIEW");
    expect(revisedOutline.json().project.staleStages).toContain("SCREENPLAY_APPROVED");
    const screenplayList = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/screenplay` });
    expect(screenplayList.json().artifacts[0].status).toBe("stale");
    await app.close();

    const restarted = await createApp({ runtimeRoot, logger: false, textProvider: fakeProvider, mediaToolchain: fakeMediaToolchain });
    const restored = await restarted.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/outline` });
    expect(restored.json().artifacts.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    await restarted.close();
  });

  it("runs the Phase 3-5 asset, handoff, import, quality, rough-cut, and delivery gates", async () => {
    const { app, project } = await createStoryApp();
    const outlineResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` });
    const outline = outlineResult.json().artifact as { id: string };
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplayResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    const screenplay = screenplayResult.json().artifact as { id: string };
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });

    const assetResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` });
    expect(assetResult.statusCode).toBe(201);
    const assetArtifact = assetResult.json().artifact as { id: string; metadata: Record<string, unknown> };
    expect(assetArtifact.metadata.route).toEqual(["ai-video-producer", "asset-bible-builder"]);
    const draftAssets = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets` });
    expect(draftAssets.json().assets).toHaveLength(3);
    expect(draftAssets.json().assets.every((asset: { approved: boolean }) => !asset.approved)).toBe(true);
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetArtifact.id } });
    const approvedAssets = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets` });
    expect(approvedAssets.json().assets.every((asset: { approved: boolean }) => asset.approved)).toBe(true);

    const shootingResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` });
    expect(shootingResult.statusCode).toBe(201);
    const shootingArtifact = shootingResult.json().artifact as { id: string };
    const shotList = await app.inject({ method: "GET", url: `/api/projects/${project.id}/shots` });
    const firstShot = shotList.json().shots[0] as { id: string; purpose: string; status: string };
    expect(firstShot.status).toBe("draft");
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: shootingArtifact.id } });

    const editedShot = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/shots/${firstShot.id}`,
      payload: {
        shot: { ...shotList.json().shots[0], purpose: "加强雨夜悬念" },
        expectedLatestArtifactId: shootingArtifact.id,
      },
    });
    expect(editedShot.statusCode).toBe(201);
    expect(editedShot.json().artifact.version).toBe(2);
    expect(editedShot.json().project.currentStage).toBe("SHOOTING_SCRIPT_REVIEW");
    const staleShotEdit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/shots/${firstShot.id}`,
      payload: {
        shot: { ...shotList.json().shots[0], purpose: "旧标签页覆盖" },
        expectedLatestArtifactId: shootingArtifact.id,
      },
    });
    expect(staleShotEdit.statusCode).toBe(409);
    expect(staleShotEdit.json().message).toMatch(/另一个标签页更新/);
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: editedShot.json().artifact.id } });

    const storyboardResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate` });
    expect(storyboardResult.statusCode).toBe(201);
    const storyboard = storyboardResult.json().artifact as { id: string; metadata: Record<string, unknown> };
    expect(storyboard.metadata.continuityPassed).toBe(true);
    expect(storyboard.metadata.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "storyboard-director" }),
      expect.objectContaining({ name: "continuity-supervisor" }),
    ]));
    const storyboardLedger = await app.inject({ method: "GET", url: `/api/projects/${project.id}/verification-ledger?through=storyboard&artifactId=${storyboard.id}` });
    expect(storyboardLedger.statusCode, storyboardLedger.body).toBe(200);
    expect(storyboardLedger.json().ledger).toMatchObject({
      schemaVersion: "cumulative-verification-v1",
      status: "healthy",
      earliestResponsibleStage: null,
      targetArtifactId: storyboard.id,
    });
    expect(storyboardLedger.json().ledger.stages.map((stage: { id: string; status: string }) => [stage.id, stage.status])).toEqual([
      ["source", "passed"], ["outline", "passed"], ["screenplay", "passed"], ["asset-bible", "passed"],
      ["shooting-script", "passed"], ["storyboard", "passed"],
    ]);
    expect(storyboardLedger.json().ledger.detectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "deterministic", health: "healthy" }),
      expect.objectContaining({ kind: "model-skill", skillName: "continuity-supervisor", health: "healthy" }),
      expect.objectContaining({ kind: "human", health: "healthy" }),
    ]));
    const continuityReport = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${storyboard.id}/continuity-report` });
    expect(continuityReport.statusCode).toBe(200);
    expect(continuityReport.json().report).toMatchObject({ passed: true, checkedShotIds: ["S001"], issues: [] });
    const reportStructuredPath = storyboard.metadata.continuityReportStructuredPath as string;
    const reportStructuredContent = await fs.readFile(reportStructuredPath, "utf8");
    await fs.rm(reportStructuredPath);
    const missingReportLedger = await app.inject({ method: "GET", url: `/api/projects/${project.id}/verification-ledger?through=storyboard&artifactId=${storyboard.id}` });
    expect(missingReportLedger.json().ledger).toMatchObject({ status: "blocked", earliestResponsibleStage: "storyboard" });
    expect(missingReportLedger.json().ledger.stages.at(-1).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CONTINUITY_REPORT", status: "failed", detectorId: expect.stringContaining("model:continuity:") }),
    ]));
    const blockedApprovalWithoutReport = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/STORYBOARD_REVIEW/approve`, payload: { artifactId: storyboard.id } });
    expect(blockedApprovalWithoutReport.statusCode).toBe(400);
    expect(blockedApprovalWithoutReport.json().message).toMatch(/报告文件不存在/);
    await fs.writeFile(reportStructuredPath, reportStructuredContent, { encoding: "utf8", flag: "wx" });
    const approvedStoryboard = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/STORYBOARD_REVIEW/approve`, payload: { artifactId: storyboard.id } });
    expect(approvedStoryboard.statusCode).toBe(200);
    expect(approvedStoryboard.json().project.currentStage).toBe("STORYBOARD_APPROVED");
    const productionLedger = await app.inject({ method: "GET", url: `/api/projects/${project.id}/verification-ledger?through=production` });
    expect(productionLedger.statusCode, productionLedger.body).toBe(200);
    expect(productionLedger.json().ledger).toMatchObject({ status: "healthy", target: "production", earliestResponsibleStage: null });

    const center = await app.inject({ method: "GET", url: `/api/projects/${project.id}/generation-center` });
    expect(center.statusCode).toBe(200);
    expect(center.json().capabilities.durationMinSec).toBe(4);
    expect(center.json().shots[0].preflight).toMatchObject({ passed: true, mode: "T2VA" });
    const locked = await app.inject({ method: "POST", url: `/api/projects/${project.id}/handoff/updream/lock-assets` });
    expect(locked.json().project.currentStage).toBe("ASSETS_LOCKED");
    const bootstrap = await app.inject({ method: "POST", url: `/api/projects/${project.id}/handoff/updream/bootstrap` });
    expect(bootstrap.statusCode).toBe(201);
    expect(bootstrap.json().project.currentStage).toBe("READY_FOR_GENERATION");
    expect(await fs.readFile(path.join(bootstrap.json().bootstrap.path, "asset-index.json"), "utf8")).toContain('"upload_state": "not-uploaded"');
    const packageOne = await app.inject({ method: "POST", url: `/api/projects/${project.id}/handoff/updream/shots/S001/package`, payload: { generationResolution: "480p" } });
    const packageTwo = await app.inject({ method: "POST", url: `/api/projects/${project.id}/handoff/updream/shots/S001/package`, payload: { generationResolution: "1080p" } });
    expect(packageOne.statusCode).toBe(201);
    expect(packageOne.json().package.version).toBe(1);
    expect(packageTwo.json().package.version).toBe(2);
    expect(packageOne.json().package.generationResolution).toBe("480p");
    expect(packageTwo.json().package.generationResolution).toBe("1080p");
    expect(packageOne.json().package.promptLanguage).toBe("zh");
    expect(packageOne.json().package.promptCharacterCount).toBeLessThanOrEqual(7000);
    expect(packageOne.json().package.requiredAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "CHAR-001", name: "剑客" }),
    ]));
    const packageSettings = JSON.parse(await fs.readFile(path.join(packageOne.json().package.path, "settings.json"), "utf8"));
    expect(packageSettings).toMatchObject({ generation_resolution: "480p", output_resolution: "1280x720" });
    expect(packageSettings).not.toHaveProperty("resolution");
    expect(await fs.readFile(packageOne.json().package.promptPath, "utf8")).toContain("integrated_multimodal_description:");
    expect(await fs.readFile(packageOne.json().package.promptPath, "utf8")).not.toContain("480p");
    const submitted = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/handoff/updream/shots/S001/packages/2/upload-state`, payload: { state: "uploaded" } });
    expect(submitted.json().package.uploadState).toBe("uploaded");
    const assetUploaded = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/assets/CHAR-001/updream-upload-state`, payload: { state: "uploaded" } });
    expect(assetUploaded.json().asset.uploadState.updream).toBe("uploaded");

    const projectDir = bootstrap.json().project.projectDir as string;
    const inboxPath = path.join(projectDir, "generated", "inbox");
    const missingPromptVideo = path.join(inboxPath, "S001_V03.mp4");
    await fs.writeFile(missingPromptVideo, "video without prompt package", "utf8");
    const missingPromptScan = await app.inject({ method: "POST", url: `/api/projects/${project.id}/generations/scan` });
    expect(missingPromptScan.statusCode).toBe(200);
    expect(missingPromptScan.json().imported).toEqual([]);
    expect(missingPromptScan.json().errors[0].reason).toMatch(/缺少对应提示词投递包/);
    await fs.rm(missingPromptVideo);
    await fs.writeFile(path.join(inboxPath, "S001_V01.mp4"), "fake generated video", "utf8");
    const imported = await app.inject({ method: "POST", url: `/api/projects/${project.id}/generations/scan` });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().project.currentStage).toBe("GENERATION_REVIEW");
    expect(imported.json().imported).toHaveLength(1);
    expect(imported.json().imported[0].media).toMatchObject({ width: 1280, height: 720, durationSec: 15 });
    expect(imported.json().imported[0].reviewFramePaths).toHaveLength(3);
    const importedWorkspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    expect(importedWorkspace.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: imported.json().imported[0].id,
        kind: "generation",
        lineageState: "current",
        sourceIds: expect.arrayContaining([storyboard.id, packageOne.json().package.id]),
      }),
    ]));
    const rescanned = await app.inject({ method: "POST", url: `/api/projects/${project.id}/generations/scan` });
    expect(rescanned.statusCode).toBe(200);
    expect(rescanned.json().errors).toEqual([]);
    expect(rescanned.json().skipped[0].reason).toMatch(/相同文件哈希/);
    const reviewFrame = await app.inject({ method: "GET", url: `/api/projects/${project.id}/generations/${imported.json().imported[0].id}/review-frames/0` });
    expect(reviewFrame.statusCode).toBe(200);
    expect(reviewFrame.headers["content-type"]).toContain("image/jpeg");
    expect(await fs.readFile(path.join(inboxPath, "S001_V01.mp4"), "utf8")).toBe("fake generated video");

    const qualityCenter = await app.inject({ method: "GET", url: `/api/projects/${project.id}/quality-center` });
    expect(qualityCenter.statusCode).toBe(200);
    expect(qualityCenter.json().skill.name).toBe("video-quality-reviewer");
    const jobId = imported.json().imported[0].id as string;
    const conditionalReview = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/generations/${jobId}/reviews`,
      payload: {
        dimensions: ["identity", "costume-props", "scene", "action", "camera", "composition-direction", "start-end-state", "picture-quality", "sound-quality"].map((dimension) => ({
          dimension,
          status: dimension === "sound-quality" ? "warning" : "pass",
          note: "人工检查记录",
          evidence: "完整观看 00:00-00:15",
        })),
        decision: "conditional-pass",
        summary: "声音仍需确认，只保存条件，不放行",
        conditions: ["完成声音复核"],
        retryInstructions: [],
        unverifiedClaims: [],
      },
    });
    expect(conditionalReview.statusCode).toBe(201);
    expect(conditionalReview.json().generation.status).toBe("review");
    const blockedRoughCut = await app.inject({ method: "POST", url: `/api/projects/${project.id}/renders/rough-cut` });
    expect(blockedRoughCut.statusCode).toBe(400);
    expect(blockedRoughCut.json().message).toMatch(/有条件通过/);
    const blockedCenter = await app.inject({ method: "GET", url: `/api/projects/${project.id}/quality-center` });
    expect(blockedCenter.json().gateAudit).toMatchObject({ passed: false, acceptedShotIds: [] });
    expect(blockedCenter.json().gateAudit.blockers.join("；")).toMatch(/条件未闭环/);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const review = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/generations/${jobId}/reviews`,
      payload: {
        dimensions: ["identity", "costume-props", "scene", "action", "camera", "composition-direction", "start-end-state", "picture-quality", "sound-quality"].map((dimension) => ({
          dimension,
          status: "pass",
          note: "人工检查通过",
          evidence: "完整观看 00:00-00:15",
        })),
        decision: "accepted",
        summary: "全部九个维度人工检查通过",
        conditions: [],
        retryInstructions: [],
        unverifiedClaims: [],
      },
    });
    expect(review.statusCode).toBe(201);
    expect(review.json().generation.status).toBe("accepted");

    await fs.rm(reportStructuredPath);
    const brokenIntegrity = await app.inject({ method: "GET", url: `/api/projects/${project.id}/integrity` });
    expect(brokenIntegrity.statusCode).toBe(200);
    expect(brokenIntegrity.json().audit).toMatchObject({ status: "blocked", firstBlockedStepId: "storyboard" });
    expect(brokenIntegrity.json().audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "storyboard", code: "CONTINUITY_REPORT_INVALID", severity: "error" }),
    ]));
    const blockedByUpstreamIntegrity = await app.inject({ method: "POST", url: `/api/projects/${project.id}/renders/rough-cut` });
    expect(blockedByUpstreamIntegrity.statusCode).toBe(400);
    expect(blockedByUpstreamIntegrity.json().message).toMatch(/项目证据审计未通过/);
    await fs.writeFile(reportStructuredPath, reportStructuredContent, { encoding: "utf8", flag: "wx" });

    const roughCut = await app.inject({ method: "POST", url: `/api/projects/${project.id}/renders/rough-cut` });
    expect(roughCut.statusCode).toBe(201);
    expect(roughCut.json().project.currentStage).toBe("FINAL_REVIEW");
    expect(roughCut.json().render.status).toBe("review");
    expect(await fs.readFile(roughCut.json().render.subtitlePath, "utf8")).toBe("");
    expect(await fs.readFile(roughCut.json().render.reportPath, "utf8")).toContain("ffprobe");
    const renderedWorkspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    expect(renderedWorkspace.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: roughCut.json().render.id, kind: "render", lineageState: "current", sourceIds: [jobId] }),
    ]));

    const delivered = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/renders/${roughCut.json().render.id}/decision`,
      payload: { decision: "approved", comment: "终审通过" },
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().project.currentStage).toBe("DELIVERED");
    expect(delivered.json().render.deliveryVideoPath).toMatch(/deliverables[\\/]v001[\\/]final\.mp4$/);
    expect(await fs.readFile(delivered.json().render.deliveryVideoPath, "utf8")).toBe("fake rough cut");
    const deliveredIntegrity = await app.inject({ method: "GET", url: `/api/projects/${project.id}/integrity` });
    expect(deliveredIntegrity.statusCode).toBe(200);
    expect(deliveredIntegrity.json().audit).toMatchObject({ status: "healthy", firstBlockedStepId: null, issues: [] });
    const downloadedVideo = await app.inject({ method: "GET", url: `/api/projects/${project.id}/renders/${roughCut.json().render.id}/files/video` });
    expect(downloadedVideo.statusCode).toBe(200);
    expect(downloadedVideo.headers["content-disposition"]).toContain("attachment");
    expect(downloadedVideo.body).toBe("fake rough cut");
    const downloadedSubtitle = await app.inject({ method: "GET", url: `/api/projects/${project.id}/renders/${roughCut.json().render.id}/files/subtitle` });
    expect(downloadedSubtitle.statusCode).toBe(200);
    expect(downloadedSubtitle.headers["content-type"]).toContain("application/x-subrip");
    const downloadedReport = await app.inject({ method: "GET", url: `/api/projects/${project.id}/renders/${roughCut.json().render.id}/files/report` });
    expect(downloadedReport.statusCode).toBe(200);
    expect(downloadedReport.headers["content-type"]).toContain("text/markdown");
    expect(downloadedReport.body).toContain("ffprobe");
    await app.close();
  });

  it("inherits deterministic storyboard asset references when the model omits them", async () => {
    const incompleteStoryboardProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateStoryboard(input) {
        const generated = await fakeProvider.generateStoryboard(input);
        return {
          ...generated,
          value: {
            ...generated.value,
            shots: generated.value.shots.map((shot) => ({
              ...shot,
              characterIds: [],
              sceneId: "SCENE-999",
              requiredAssetIds: [],
            })),
          },
        };
      },
    };
    const { app, project } = await createStoryApp(incompleteStoryboardProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    const assetBible = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetBible.id } });
    const shootingScript = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: shootingScript.id } });

    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate` });
    expect(response.statusCode).toBe(201);
    const persisted = JSON.parse(await fs.readFile(response.json().artifact.structuredPath, "utf8"));
    expect(persisted.shots[0]).toMatchObject({
      characterIds: ["CHAR-001"],
      sceneId: "SCENE-001",
      requiredAssetIds: ["CHAR-001", "SCENE-001", "STYLE-001"],
    });
    expect(response.json().project.currentStage).toBe("STORYBOARD_REVIEW");
    await app.close();
  });

  it("preserves a generated storyboard when continuity fails and retries only the review", async () => {
    let storyboardRuns = 0;
    let continuityRuns = 0;
    const stalledContinuityProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateStoryboard(input) {
        storyboardRuns += 1;
        return fakeProvider.generateStoryboard(input);
      },
      async reviewContinuity(input) {
        continuityRuns += 1;
        if (continuityRuns === 1) throw new Error("连续性检查测试超时");
        return fakeProvider.reviewContinuity(input);
      },
    };
    const { app, project } = await createStoryApp(stalledContinuityProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    const assetBible = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetBible.id } });
    const shootingScript = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: shootingScript.id } });

    const generated = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate`, payload: { autoRepair: false } });
    expect(generated.statusCode, generated.body).toBe(201);
    expect(generated.json().continuityReview).toMatchObject({ status: "failed", message: "连续性检查测试超时" });
    expect(generated.json().artifact.metadata).toMatchObject({ continuityReviewStatus: "failed", continuityPassed: false });
    const artifactId = generated.json().artifact.id;
    const failedReport = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${artifactId}/continuity-report` });
    expect(failedReport.json().report).toMatchObject({
      passed: false,
      issues: [expect.objectContaining({ code: "CONTINUITY_REVIEW_UNAVAILABLE" })],
    });

    const retried = await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${artifactId}/continuity-review` });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json().artifact).toMatchObject({ id: artifactId, version: 1 });
    expect(retried.json().artifact.metadata).toMatchObject({ continuityReviewStatus: "completed", continuityPassed: true });
    expect(retried.json().artifact.metadata.continuityReviewAttempts).toHaveLength(2);
    expect(storyboardRuns).toBe(1);
    expect(continuityRuns).toBe(2);
    await app.close();
  });

  it("keeps a rejected storyboard explicit and repairs it only through a user-started persistent operation", async () => {
    let continuityRuns = 0;
    const autoRepairProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async reviewContinuity() {
        continuityRuns += 1;
        return continuityRuns === 1
          ? {
              value: {
                checkedShotIds: ["S001"],
                issues: [{
                  severity: "error" as const,
                  code: "CAMERA_COMPOSITION_MISMATCH",
                  message: "S001 的构图没有保留门与人物的空间关系。",
                  affectedIds: ["S001"],
                  suggestedFix: "修订分镜 composition，明确人物在左、门在中间且摄影机始终位于门内。",
                  requiresReapproval: true,
                }],
                passed: false,
                uncheckedClaims: [],
              },
              trace: fakeTrace("continuity-supervisor", "continuity-supervisor-v1"),
            }
          : { value: { checkedShotIds: ["S001"], issues: [], passed: true, uncheckedClaims: [] }, trace: fakeTrace("continuity-supervisor", "continuity-supervisor-v1") };
      },
      async repairStoryboard(input) {
        return {
          value: {
            ...input.currentStoryboard,
            shots: input.currentStoryboard.shots.map((shot) => shot.shotId === "S001"
              ? { ...shot, composition: "人物在左、门在中间，摄影机始终位于门内。", approved: false }
              : shot),
          },
          trace: fakeTrace("storyboard-director", "storyboard-v2"),
        };
      },
    };
    const { app, project } = await createStoryApp(autoRepairProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    const assetBible = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetBible.id } });
    const shootingScript = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: shootingScript.id } });

    const generated = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate` });

    expect(generated.statusCode, generated.body).toBe(201);
    expect(generated.json().autoRepair).toBeUndefined();
    expect(generated.json().continuityReview).toMatchObject({ status: "completed", message: null });
    expect(generated.json().artifact.version).toBe(1);
    expect(generated.json().artifact.metadata.continuityPassed).toBe(false);
    expect(continuityRuns).toBe(1);

    const initialWorkspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const originalHeadId = initialWorkspace.artifactGroups.find((group: { type: string }) => group.type === "storyboard").head.id;
    expect(originalHeadId).toBe(generated.json().artifact.id);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/${originalHeadId}/decisions`,
      payload: { decision: "rejected", comment: "按连续性报告修复" },
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    const rejectedDetail = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${originalHeadId}` });
    expect(rejectedDetail.json()).toMatchObject({
      artifact: { status: "rejected", state: "rejected", isHead: true },
      approvals: [{ decision: "rejected", comment: "按连续性报告修复" }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/${originalHeadId}/continuity-repair-operations`,
      payload: { idempotencyKey: "repair-rejected-storyboard" },
    });
    expect(response.statusCode, response.body).toBe(202);
    const operation = await waitForOperation(app, response.json().operationId);
    expect(operation).toMatchObject({
      status: "succeeded",
      resultPayload: { version: 2, artifactType: "storyboard", headChanged: false, remainingIssueCodes: [] },
    });
    const refreshed = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const storyboardGroup = refreshed.artifactGroups.find((group: { type: string }) => group.type === "storyboard");
    expect(storyboardGroup.head).toMatchObject({ id: originalHeadId, status: "rejected", state: "rejected" });
    expect(storyboardGroup.versions).toHaveLength(2);
    const repairedDetail = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${operation.resultPayload.artifactId}` });
    expect(repairedDetail.json()).toMatchObject({ artifact: { version: 2, isHead: false, metadata: { continuityPassed: true } } });
    expect(continuityRuns).toBe(2);
    await app.close();
  });

  it("repairs only affected assets and shots while preserving human approval gates", async () => {
    let continuityRuns = 0;
    const continuityInputs: Parameters<TextIntelligenceProvider["reviewContinuity"]>[0][] = [];
    const targetedRepairProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateShootingScript(input) {
        const generated = await fakeProvider.generateShootingScript(input);
        const template = generated.value.shots[0];
        return {
          ...generated,
          value: {
            ...generated.value,
            shots: [
              { ...template, id: "S001", sequence: 1, startTimeSec: 0, endTimeSec: 5, durationSec: 5, action: "0.0—5.0秒，剑客进入客栈并看向油灯。", sound: ["4.70秒开始电流噼啪，随后与灯光逐次同步。"] },
              { ...template, id: "S002", sequence: 2, startTimeSec: 5, endTimeSec: 15, durationSec: 10, action: "5.0—7.7秒，油灯亮起。7.7—8.7秒，人群虚影横向经过；8.7—15.0秒，剑客回头，画面在15.0秒截断。", startState: "承接S001结束状态", endState: "人群虚影仍在经过，剑客完成回头" },
            ],
          },
        };
      },
      async generateStoryboard(input) {
        return {
          value: {
            schemaVersion: "storyboard-v1" as const,
            shots: input.approvedShootingScript.shots.map((shot) => ({
              shotId: shot.id,
              startFrame: `${input.project.aspectRatio} 横幅起始帧`,
              endFrame: shot.id === "S002" ? "人群虚影仍在经过的结束帧" : "剑客看向油灯",
              composition: `${input.project.aspectRatio} 横幅稳定构图`,
              motionPlan: shot.id === "S002" ? "7.7—8.7秒，人群虚影横向经过；随后人物回头至15.0秒。" : "0.0—5.0秒稳定推进。",
              characterIds: shot.characterIds,
              sceneId: shot.sceneId,
              requiredAssetIds: [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds],
              continuityRisks: [],
              physicalVerification: null,
              approved: false,
            })),
              globalContinuityNotes: ["SCENE-001 的9:16竖幅描述与项目16:9冲突，等待确认。"],
          },
          trace: fakeTrace("storyboard-director", "storyboard-director-v1"),
        };
      },
      async reviewContinuity(input) {
        continuityRuns += 1;
        continuityInputs.push(input);
        return continuityRuns === 1
          ? {
              value: {
                checkedShotIds: ["S001", "S002"],
                issues: [
                  { severity: "error" as const, code: "ASPECT_RATIO_CONFLICT", message: "SCENE-001规定9:16竖幅，但项目采用16:9。", affectedIds: ["SCENE-001", "S001", "S002"], suggestedFix: "将SCENE-001统一为16:9横幅。", requiresReapproval: true },
                  { severity: "warning" as const, code: "S002_CROWD_END_STATE_TIMING_AMBIGUOUS", message: "S002动作将虚影安排在7.7—8.7秒，但15.0秒仍在经过。", affectedIds: ["S002"], suggestedFix: "将虚影明确为7.7秒开始并持续至15.0秒。", requiresReapproval: true },
                  { severity: "warning" as const, code: "MIRROR_PARITY_RULE_UNDEFINED", message: "镜中人物的解剖侧与屏幕侧关系未定义。", affectedIds: ["CHAR-001", "S001", "S002"], suggestedFix: "保持解剖侧一致并采用正常镜面左右反转。", requiresReapproval: true },
                  { severity: "warning" as const, code: "SHOT_BOUNDARY_FRAME_STATE_UNDERSPECIFIED", message: "S001尾帧与S002首帧状态未完全对齐。", affectedIds: ["S001", "S002"], suggestedFix: "把S001尾帧状态逐项复制到S002首帧。", requiresReapproval: true },
                  { severity: "error" as const, code: "LIGHT_SOUND_SYNC_TIMECODE_CONFLICT", message: "S001画面从4.30秒变化，但声音推迟到4.70秒。", affectedIds: ["S001", "AUDIO-002"], suggestedFix: "将S001声音说明中的电流噼啪起点改为4.30秒。", requiresReapproval: true },
                  { severity: "error" as const, code: "CHARACTER_ORIENTATION_STATE_CONFLICT", message: "S001尾状态与S002首状态的人物朝向冲突。", affectedIds: ["S001", "S002", "CHAR-001"], suggestedFix: "CHAR-001的躯干和头部保持朝向电梯门，仅眼睛看向右侧镜面；手机高度与僵硬姿态保持不变。", requiresReapproval: true },
                  { severity: "warning" as const, code: "ASSET_VERSION_LOCK_UNVERIFIABLE", message: "ShotSpec与分镜没有绑定已批准资产版本。", affectedIds: ["S001", "S002"], suggestedFix: "锁定已批准 Asset Bible 的版本和哈希。", requiresReapproval: false },
                ],
                passed: false,
                uncheckedClaims: [],
              },
              trace: fakeTrace("continuity-supervisor", "continuity-supervisor-v1"),
            }
          : { value: { checkedShotIds: ["S001", "S002"], issues: [], passed: true, uncheckedClaims: [] }, trace: fakeTrace("continuity-supervisor", "continuity-supervisor-v1") };
      },
    };
    const { app, project } = await createStoryApp(targetedRepairProvider);
    const outline = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/outline/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`, payload: { artifactId: outline.id } });
    const screenplay = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SCREENPLAY_REVIEW/approve`, payload: { artifactId: screenplay.id } });
    const assetBible = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/asset-bible/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`, payload: { artifactId: assetBible.id } });
    const shootingScript = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/shooting-script/generate` })).json().artifact;
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: shootingScript.id } });

    const legacyAssetBible = JSON.parse(await fs.readFile(assetBible.structuredPath, "utf8"));
    legacyAssetBible.assets = legacyAssetBible.assets.map((asset: { id: string; appearance: string; continuityRules: string[]; negativeConstraints: string[] }) => asset.id === "SCENE-001"
      ? { ...asset, appearance: "9:16竖幅冷灰电影风格，雨夜环境使用冷蓝阴影，人物与油灯保留克制暖色轮廓光，并始终保持纵向构图。", continuityRules: ["全片维持9:16竖幅与统一冷灰色调"], negativeConstraints: ["不得裁成9:16竖幅"] }
      : asset);
    await fs.writeFile(assetBible.structuredPath, `${JSON.stringify(legacyAssetBible, null, 2)}\n`, "utf8");

    const storyboard = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate`, payload: { autoRepair: false } })).json().artifact;
    expect(storyboard.metadata.continuityPassed).toBe(false);
    const originalShooting = JSON.parse(await fs.readFile(shootingScript.structuredPath, "utf8"));
    const originalStoryboard = JSON.parse(await fs.readFile(storyboard.structuredPath, "utf8"));

    const repairPlan = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${storyboard.id}/continuity-repair-plan` });
    expect(repairPlan.statusCode, repairPlan.body).toBe(200);
    expect(repairPlan.json().plan).toMatchObject({
      totalIssueCount: 7,
      currentStep: { order: 1, target: "asset-bible", actionLabel: "重构资产定义" },
      steps: [
        { target: "asset-bible", purpose: "repair" },
        { target: "shooting-script", purpose: "repair" },
        { target: "storyboard", purpose: "repair" },
      ],
      requiresApprovalBetweenSteps: true,
    });

    const assetRepairRequest = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/artifacts/${storyboard.id}/continuity-repair-operations`,
      payload: { idempotencyKey: "systemic-asset-repair" },
    });
    expect(assetRepairRequest.statusCode, assetRepairRequest.body).toBe(202);
    const assetRepair = await waitForOperation(app, assetRepairRequest.json().operationId);
    expect(assetRepair, JSON.stringify(assetRepair)).toMatchObject({ status: "succeeded", resultPayload: { artifactType: "asset-bible", headChanged: false, continuationTarget: "shooting-script" } });
    const repairedAssetArtifact = (await app.inject({
      method: "GET", url: `/api/projects/${project.id}/artifacts/${assetRepair.resultPayload.artifactId}`,
    })).json().artifact;
    const repairedAssetBible = JSON.parse(await fs.readFile(repairedAssetArtifact.structuredPath, "utf8"));
    expect(repairedAssetBible.assets.find((asset: { id: string }) => asset.id === "SCENE-001").appearance).toContain("16:9横幅");
    expect(repairedAssetBible.assets.find((asset: { id: string; negativeConstraints: string[] }) => asset.id === "SCENE-001").negativeConstraints).toContain("不得裁成9:16竖幅");
    const repairedCharacter = repairedAssetBible.assets.find((asset: { id: string }) => asset.id === "CHAR-001");
    const originalCharacter = legacyAssetBible.assets.find((asset: { id: string }) => asset.id === "CHAR-001");
    expect(repairedCharacter.continuityRules).toContain(MIRROR_PARITY_CONTINUITY_RULE);
    expect({ ...repairedCharacter, continuityRules: originalCharacter.continuityRules }).toEqual(originalCharacter);
    expect((await fs.readFile(assetBible.structuredPath, "utf8"))).toContain("9:16竖幅");

    const prematureAssetApproval = await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${repairedAssetArtifact.id}/decisions`, payload: { decision: "approved" } });
    expect(prematureAssetApproval.statusCode).toBe(400);
    expect(prematureAssetApproval.json().message).toContain("选择为 Head");
    await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/heads/asset-bible`, payload: { artifactId: repairedAssetArtifact.id, selectedBy: "user" } });
    const repairedAssetApproval = await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${repairedAssetArtifact.id}/decisions`, payload: { decision: "approved" } });
    expect(repairedAssetApproval.statusCode, repairedAssetApproval.body).toBe(201);
    const shootingRepairRequest = await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${repairedAssetArtifact.id}/continuity-repair-operations`, payload: { idempotencyKey: "systemic-shooting-repair" } });
    expect(shootingRepairRequest.statusCode, shootingRepairRequest.body).toBe(202);
    const shootingRepair = await waitForOperation(app, shootingRepairRequest.json().operationId);
    expect(shootingRepair).toMatchObject({ status: "succeeded", resultPayload: { artifactType: "shooting-script", headChanged: false, continuationTarget: "storyboard" } });
    const repairedShootingArtifact = (await app.inject({
      method: "GET", url: `/api/projects/${project.id}/artifacts/${shootingRepair.resultPayload.artifactId}`,
    })).json().artifact;
    const repairedShooting = JSON.parse(await fs.readFile(repairedShootingArtifact.structuredPath, "utf8"));
    const repairedShootingS001 = repairedShooting.shots.find((shot: { id: string }) => shot.id === "S001");
    const originalShootingS001 = originalShooting.shots.find((shot: { id: string }) => shot.id === "S001");
    expect(repairedShootingS001.sound).toContain("4.30秒开始电流噼啪，随后与灯光逐次同步。");
    expect({ ...repairedShootingS001, sound: originalShootingS001.sound, endState: originalShootingS001.endState }).toEqual(originalShootingS001);
    expect(repairedShooting.shots.find((shot: { id: string; action: string }) => shot.id === "S002").action).toContain("7.7—15.0秒");
    expect(repairedShootingS001.endState).toContain("躯干和头部保持朝向电梯门");
    expect(repairedShooting.shots.find((shot: { id: string; startState: string }) => shot.id === "S002").startState).toContain("躯干和头部保持朝向电梯门");
    expect(repairedShootingArtifact.metadata.approvedAssetBibleLock).toMatchObject({
      artifactId: repairedAssetArtifact.id,
      version: repairedAssetArtifact.version,
      contentHash: repairedAssetArtifact.contentHash,
    });

    await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/heads/shooting-script`, payload: { artifactId: repairedShootingArtifact.id, selectedBy: "user" } });
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${repairedShootingArtifact.id}/decisions`, payload: { decision: "approved" } });
    const storyboardRepairRequest = await app.inject({ method: "POST", url: `/api/projects/${project.id}/artifacts/${repairedShootingArtifact.id}/continuity-repair-operations`, payload: { idempotencyKey: "systemic-storyboard-repair" } });
    expect(storyboardRepairRequest.statusCode, storyboardRepairRequest.body).toBe(202);
    const storyboardRepair = await waitForOperation(app, storyboardRepairRequest.json().operationId);
    expect(storyboardRepair).toMatchObject({ status: "succeeded", resultPayload: { artifactType: "storyboard", headChanged: false } });
    const repairedStoryboardArtifact = (await app.inject({
      method: "GET", url: `/api/projects/${project.id}/artifacts/${storyboardRepair.resultPayload.artifactId}`,
    })).json().artifact;
    expect(repairedStoryboardArtifact.metadata.continuityPassed).toBe(true);
    const repairedStoryboard = JSON.parse(await fs.readFile(repairedStoryboardArtifact.structuredPath, "utf8"));
    const repairedS001 = repairedStoryboard.shots.find((shot: { shotId: string }) => shot.shotId === "S001");
    const originalS001 = originalStoryboard.shots.find((shot: { shotId: string }) => shot.shotId === "S001");
    expect(repairedS001.composition).toContain(MIRROR_PARITY_CONTINUITY_RULE);
    expect({ ...repairedS001, composition: originalS001.composition, endFrame: originalS001.endFrame }).toEqual(originalS001);
    const repairedS002 = repairedStoryboard.shots.find((shot: { shotId: string; motionPlan: string; startFrame: string }) => shot.shotId === "S002");
    expect(repairedS002.motionPlan).toContain("7.7—15.0秒");
    expect(repairedS002.startFrame).toContain(originalS001.endFrame.replace(/。$/, ""));
    expect(repairedS001.endFrame).toContain("躯干和头部保持朝向电梯门");
    expect(repairedS002.startFrame).toContain("躯干和头部保持朝向电梯门");
    expect(repairedStoryboard.globalContinuityNotes.some((note: string) => note.includes("资产版本锁定：asset-bible-v"))).toBe(true);
    expect(repairedStoryboardArtifact.metadata.approvedAssetBibleLock).toMatchObject({
      artifactId: repairedAssetArtifact.id,
      version: repairedAssetArtifact.version,
      contentHash: repairedAssetArtifact.contentHash,
    });
    const repairedReport = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${repairedStoryboardArtifact.id}/continuity-report` });
    expect(repairedReport.json().report.passed).toBe(true);
    expect(continuityRuns).toBe(2);
    expect(continuityInputs.every((input) => input.approvedAssetBibleRef === input.approvedAssetBibleLock.reference)).toBe(true);
    expect(continuityInputs.every((input) => input.approvedShootingScriptRef.startsWith("shooting-script-v"))).toBe(true);
    await app.close();
  });
});
