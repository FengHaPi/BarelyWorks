import { describe, expect, it } from "vitest";
import { importedMediaIssues } from "../src/media/import-validation";
import { projectSchema, shotSpecSchema } from "../src/shared/schemas";

const project = projectSchema.parse({
  id: "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a",
  title: "媒体门禁",
  sourceType: "story",
  targetDurationSec: 5,
  aspectRatio: "16:9",
  resolution: "1280x720",
  videoType: null,
  visualStyle: null,
  releasePlatform: null,
  targetAudience: null,
  allowStorySuggestions: true,
  currentStage: "GENERATING",
  staleStages: [],
  sourcePath: "source.txt",
  projectDir: "project",
  archivedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
});

const shot = shotSpecSchema.parse({
  id: "S001",
  projectId: project.id,
  sequence: 1,
  startTimeSec: 0,
  endTimeSec: 5,
  durationSec: 5,
  purpose: "测试",
  characterIds: [],
  sceneId: "SCENE-001",
  propIds: [],
  styleIds: [],
  shotSize: "全景",
  camera: { position: "平视", movement: "固定" },
  action: "测试",
  dialogue: [],
  sound: [],
  startState: "开始",
  endState: "结束",
  status: "approved",
});

const baseMedia = {
  durationSec: 5,
  width: 854,
  height: 480,
  frameRate: 24,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
  formatName: "mp4",
  sizeBytes: 1_000,
};

describe("generated media import gates", () => {
  it("accepts a matching 480p clip", () => {
    expect(importedMediaIssues(project, shot, baseMedia)).toEqual([]);
  });

  it("reports duration, aspect, and minimum-resolution mismatches", () => {
    const issues = importedMediaIssues(project, shot, { ...baseMedia, durationSec: 1, width: 360, height: 640 });
    expect(issues.join("；")).toMatch(/时长/);
    expect(issues.join("；")).toMatch(/画幅/);
    expect(issues.join("；")).toMatch(/480p/);
  });
});
