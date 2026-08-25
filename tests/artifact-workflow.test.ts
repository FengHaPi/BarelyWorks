import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server";
import type { TextGenerationTrace, TextIntelligenceProvider } from "../src/ai/text-provider";
import type { StudioSkillName } from "../src/skills/skill-registry";
import type { MediaToolchain } from "../src/media/media-toolchain";

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
      version: "0.1.0",
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
  async generateShootingScript({ project }) {
    return { value: {
      targetDurationSec: project.targetDurationSec,
      shots: [{
        id: "S001", projectId: project.id, sequence: 1, startTimeSec: 0, endTimeSec: project.targetDurationSec,
        durationSec: project.targetDurationSec, purpose: "建立悬念", characterIds: ["CHAR-001"], sceneId: "SCENE-001",
        propIds: [], styleIds: ["STYLE-001"], shotSize: "全景至中景", camera: { position: "门内平视", movement: "缓慢推进", lens: "35mm", composition: "人物居左" },
        action: "剑客进入，油灯自行亮起。", dialogue: [], sound: ["雨声"], startState: "客栈空镜", endState: "剑客站在门内", preferredProvider: null, status: "draft" as const,
      }],
      validationNotes: [],
    }, trace: fakeTrace("shooting-script-director", "shooting-script-director-v1") };
  },
  async generateStoryboard() {
    return { value: {
      shots: [{ shotId: "S001", startFrame: "客栈空镜", endFrame: "剑客站在门内", composition: "人物居左，油灯居右", motionPlan: "缓慢推进", characterIds: ["CHAR-001"], sceneId: "SCENE-001", requiredAssetIds: ["CHAR-001", "SCENE-001", "STYLE-001"], continuityRisks: [], approved: false }],
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
          ? `subject_definitions:\n${input.referenceLabels.map((item) => `${item.label} is the approved ${item.assetId} reference.`).join("\n")}\n\nsummary:\n[reference generation] The approved shot is prepared.\n\nretention_analysis:\n${input.referenceLabels.map((item) => `${item.label}: fully_preserved - keep the approved identity.`).join("\n")}\n\ndetailed_description:\n[Shot 1] Live-action, cinematic, the approved action unfolds in one continuous shot.\n\noverall_soundscape:\nSteady rain and room tone.\n\nnon_diegetic_music:\nN/A`
          : "integrated_multimodal_description: [Shot 1] Live-action, cinematic, a black-clad swordsman enters the dim inn as the camera slowly pushes in.\n\noverall_soundscape: Steady rain and quiet room tone.\n\nnon_diegetic_music: N/A",
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
  return { app, runtimeRoot, project: response.json().project as { id: string } };
}

describe("versioned text workflow", () => {
  it("blocks screenplay generation before the outline approval gate", async () => {
    const { app, project } = await createStoryApp();
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/screenplay/generate` });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/先批准剧情大纲/);
    await app.close();
  });

  it("blocks approval when a valid timeline contains H3-incompatible shot durations", async () => {
    const incompatibleProvider: TextIntelligenceProvider = {
      ...fakeProvider,
      async generateShootingScript(input) {
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

    const approval = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`,
      payload: { artifactId: shootingResult.json().artifact.id },
    });

    expect(approval.statusCode).toBe(400);
    expect(approval.json().message).toMatch(/H3.*4–15 秒/);
    expect(approval.json().message).toContain("S001=3秒");
    expect(approval.json().message).toContain("请驳回并重新生成");
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
            assets: generated.value.assets.map((asset) => asset.id === "CHAR-001" ? {
              ...asset,
              appearance: "具体颜色及其他外貌尚未确定。",
              designBasis: "source-grounded" as const,
              productionReady: false,
              designSummary: "",
              distinctiveFeatures: [],
              negativeConstraints: [],
              unknowns: ["服装、发型、面部与体型尚未确定"],
            } : asset),
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

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/assets/CHAR-001/references`,
      payload: {
        fileName: "character.png",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4l9sAAAAASUVORK5CYII=",
        role: "主参考",
        authorizationConfirmed: true,
      },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().asset).toMatchObject({ designBasis: "reference-guided", productionReady: true, fileRoles: ["主参考"], authorizationState: "confirmed" });
    expect(uploaded.json().asset.sha256[0]).toMatch(/^[a-f0-9]{64}$/);
    const preview = await app.inject({ method: "GET", url: `/api/projects/${project.id}/assets/CHAR-001/references/0` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("image/png");

    const approved = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/ASSET_BIBLE_REVIEW/approve`,
      payload: { artifactId: assetResult.json().artifact.id },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().project.currentStage).toBe("ASSET_BIBLE_APPROVED");
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
      payload: { content: first.content },
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
      payload: { content: `${first.content}\n\n加强后的结尾悬念。` },
    });
    const second = revised.json().artifact as { id: string; version: number };
    expect(second.version).toBe(2);
    const approveSecond = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stages/OUTLINE_REVIEW/approve`,
      payload: { artifactId: second.id },
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
      expect.objectContaining({ name: "story-architect", version: "0.1.0", sha256: fakeSha256 }),
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
      payload: { content: `${outline.content}\n\n人工补充说明。` },
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
      payload: { ...shotList.json().shots[0], purpose: "加强雨夜悬念" },
    });
    expect(editedShot.statusCode).toBe(201);
    expect(editedShot.json().artifact.version).toBe(2);
    expect(editedShot.json().project.currentStage).toBe("SHOOTING_SCRIPT_REVIEW");
    await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/SHOOTING_SCRIPT_REVIEW/approve`, payload: { artifactId: editedShot.json().artifact.id } });

    const storyboardResult = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/storyboard/generate` });
    expect(storyboardResult.statusCode).toBe(201);
    const storyboard = storyboardResult.json().artifact as { id: string; metadata: Record<string, unknown> };
    expect(storyboard.metadata.continuityPassed).toBe(true);
    expect(storyboard.metadata.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "storyboard-director" }),
      expect.objectContaining({ name: "continuity-supervisor" }),
    ]));
    const approvedStoryboard = await app.inject({ method: "POST", url: `/api/projects/${project.id}/stages/STORYBOARD_REVIEW/approve`, payload: { artifactId: storyboard.id } });
    expect(approvedStoryboard.statusCode).toBe(200);
    expect(approvedStoryboard.json().project.currentStage).toBe("STORYBOARD_APPROVED");

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
    await fs.writeFile(path.join(inboxPath, "S001_V01.mp4"), "fake generated video", "utf8");
    const imported = await app.inject({ method: "POST", url: `/api/projects/${project.id}/generations/scan` });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().project.currentStage).toBe("GENERATION_REVIEW");
    expect(imported.json().imported).toHaveLength(1);
    expect(imported.json().imported[0].media).toMatchObject({ width: 1280, height: 720, durationSec: 15 });
    expect(imported.json().imported[0].reviewFramePaths).toHaveLength(3);
    const reviewFrame = await app.inject({ method: "GET", url: `/api/projects/${project.id}/generations/${imported.json().imported[0].id}/review-frames/0` });
    expect(reviewFrame.statusCode).toBe(200);
    expect(reviewFrame.headers["content-type"]).toContain("image/jpeg");
    expect(await fs.readFile(path.join(inboxPath, "S001_V01.mp4"), "utf8")).toBe("fake generated video");

    const qualityCenter = await app.inject({ method: "GET", url: `/api/projects/${project.id}/quality-center` });
    expect(qualityCenter.statusCode).toBe(200);
    expect(qualityCenter.json().skill.name).toBe("video-quality-reviewer");
    const jobId = imported.json().imported[0].id as string;
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

    const roughCut = await app.inject({ method: "POST", url: `/api/projects/${project.id}/renders/rough-cut` });
    expect(roughCut.statusCode).toBe(201);
    expect(roughCut.json().project.currentStage).toBe("FINAL_REVIEW");
    expect(roughCut.json().render.status).toBe("review");
    expect(await fs.readFile(roughCut.json().render.subtitlePath, "utf8")).toBe("");
    expect(await fs.readFile(roughCut.json().render.reportPath, "utf8")).toContain("ffprobe");

    const delivered = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/renders/${roughCut.json().render.id}/decision`,
      payload: { decision: "approved", comment: "终审通过" },
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().project.currentStage).toBe("DELIVERED");
    expect(delivered.json().render.deliveryVideoPath).toMatch(/deliverables[\\/]v001[\\/]final\.mp4$/);
    expect(await fs.readFile(delivered.json().render.deliveryVideoPath, "utf8")).toBe("fake rough cut");
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
});
