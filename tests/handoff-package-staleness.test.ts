import { describe, expect, it } from "vitest";
import { shotSpecFingerprint } from "../src/handoff/updream-package-builder";
import { bindHandoffPackageToCurrentShot } from "../src/projects/project-service";
import type { HandoffPackageSummary } from "../src/shared/handoff-schemas";
import { shotSpecSchema } from "../src/shared/schemas";
import { H3_EXECUTION_POLICY_VERSION } from "../src/shared/h3-executability";

const shot = shotSpecSchema.parse({
  id: "S001",
  projectId: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
  startTimeSec: 0,
  endTimeSec: 7.5,
  durationSec: 7.5,
  purpose: "测试版本绑定",
  characterIds: [],
  sceneId: "SCENE-001",
  propIds: [],
  styleIds: [],
  shotSize: "中景",
  camera: { position: "平视", movement: "固定", lens: null, composition: null },
  action: "人物进入画面。",
  dialogue: [],
  sound: [],
  startState: "空镜",
  endState: "人物站定",
  physicalPlan: null,
  preferredProvider: null,
  status: "approved",
});

function packageSummary(overrides: Partial<HandoffPackageSummary> = {}): HandoffPackageSummary {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    shotId: "S001",
    version: 2,
    path: "C:\\project\\handoff\\S001\\v002",
    promptPath: "C:\\project\\handoff\\S001\\v002\\prompt.txt",
    createdAt: "2026-08-26T00:00:00.000Z",
    mode: "T2VA",
    generationResolution: "platform-default",
    requestedDurationSec: 7.5,
    sourceShotSpecHash: shotSpecFingerprint(shot),
    sourceStoryboardArtifactId: "33333333-3333-4333-8333-333333333333",
    promptPolicyVersion: H3_EXECUTION_POLICY_VERSION,
    isStale: false,
    staleReasons: [],
    uploadState: "not-uploaded",
    promptCharacterCount: 100,
    promptLanguage: "zh",
    requiredAssets: [],
    ...overrides,
  };
}

describe("H3 package to ShotSpec binding", () => {
  it("marks a historical 9-second package stale against the current 7.5-second shot", () => {
    const result = bindHandoffPackageToCurrentShot(packageSummary({ requestedDurationSec: 9, sourceShotSpecHash: null }), shot);
    expect(result.isStale).toBe(true);
    expect(result.staleReasons).toEqual(expect.arrayContaining([
      expect.stringContaining("投递包绑定 9 秒"),
      expect.stringContaining("未绑定来源 ShotSpec 指纹"),
    ]));
  });

  it("keeps a package current only when duration and ShotSpec fingerprint both match", () => {
    expect(bindHandoffPackageToCurrentShot(packageSummary(), shot)).toMatchObject({ isStale: false, staleReasons: [] });
  });

  it("does not invalidate a prompt package when only the operational review status changes", () => {
    const acceptedShot = shotSpecSchema.parse({ ...shot, status: "accepted" });
    expect(bindHandoffPackageToCurrentShot(packageSummary(), acceptedShot)).toMatchObject({ isStale: false, staleReasons: [] });
  });

  it("marks a package from the old prompt policy stale", () => {
    const result = bindHandoffPackageToCurrentShot(packageSummary({ promptPolicyVersion: null }), shot);
    expect(result.isStale).toBe(true);
    expect(result.staleReasons.join("；")).toContain(H3_EXECUTION_POLICY_VERSION);
  });
});
