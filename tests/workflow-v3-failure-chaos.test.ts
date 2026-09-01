import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  contentHashV3,
  evaluateProductionGateV3,
  verifyArtifactV3,
  type AdoptionReceiptV3,
  type AdoptionV3,
  type ApprovalReceiptV3,
  type ArtifactKindV3,
  type ArtifactRecordV3,
  type VerificationReceiptV3,
} from "../src/workflow-v3";

interface GoldenBaselineV3 {
  schemaVersion: "workflow-v3-golden-baseline-v1";
  sourceLiveRunId: string;
  sourceResultHash: string;
  artifacts: ArtifactRecordV3[];
  verifications: VerificationReceiptV3[];
}

const repositoryRoot = path.resolve(".");
const goldenPath = path.resolve("tests/fixtures/workflow-v3-golden-live-001.json");
const goldenText = fs.readFileSync(goldenPath, "utf8");
const golden = JSON.parse(goldenText) as GoldenBaselineV3;
const goldenObjectSnapshot = JSON.stringify(golden);
const liveRunRoot = path.resolve("projects/workflow-v3-live/20260831-first-live-e2e");
const oldDatabasePath = path.resolve("data/studio.sqlite");

function fileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function directorySnapshot(root: string): Array<{ path: string; hash: string }> {
  if (!fs.existsSync(root)) return [];
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? visit(absolute) : [absolute];
  });
  return visit(root).sort().map((filePath) => ({
    path: path.relative(root, filePath).replace(/\\/gu, "/"),
    hash: fileHash(filePath)!,
  }));
}

function activeArtifacts(): ArtifactRecordV3[] {
  const artifacts = structuredClone(golden.artifacts.filter((artifact) => artifact.kind !== "generation-package"));
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  for (const artifact of artifacts) {
    artifact.inputArtifactRefs = artifact.inputArtifactIds.map((artifactId) => ({
      artifactId,
      contentHash: byId.get(artifactId)!.contentHash,
    }));
  }
  return artifacts;
}

function activeVerifications(): VerificationReceiptV3[] {
  const activeIds = new Set(activeArtifacts().map((artifact) => artifact.artifactId));
  return structuredClone(golden.verifications.filter((receipt) => activeIds.has(receipt.artifactId)));
}

function requireArtifact(artifacts: ArtifactRecordV3[], kind: ArtifactKindV3): ArtifactRecordV3 {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) throw new Error(`Golden baseline is missing ${kind}`);
  return artifact;
}

function withCandidate(artifacts: ArtifactRecordV3[], candidate: ArtifactRecordV3): ArtifactRecordV3[] {
  return artifacts.map((artifact) => artifact.artifactId === candidate.artifactId ? candidate : artifact);
}

function gateAuthority(artifacts: ArtifactRecordV3[], verifications: VerificationReceiptV3[]): {
  approvals: ApprovalReceiptV3[];
  adoptions: AdoptionV3[];
  currentAdoptionReceipts: AdoptionReceiptV3[];
} {
  const adopted = artifacts.filter((artifact) => ["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"].includes(artifact.kind));
  const adoptionIds = new Map(adopted.map((artifact, index) => [
    artifact.artifactId,
    `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ]));
  const approvals = adopted.map((artifact): ApprovalReceiptV3 => {
    const verification = verifications.find((receipt) => receipt.artifactId === artifact.artifactId)!;
    return {
      schemaVersion: "workflow-v3-approval-v1",
      receiptId: `golden-approval-${artifact.kind}`,
      projectId: artifact.projectId,
      artifactId: artifact.artifactId,
      artifactHash: artifact.contentHash,
      verificationReceiptId: verification.receiptId,
      decision: "approved",
      decidedAt: "2026-08-31T08:00:00.000Z",
      decidedBy: "human",
    };
  });
  const adoptions = adopted.map((artifact): AdoptionV3 => ({
      schemaVersion: "workflow-v3-adoption-v1",
      adoptionId: adoptionIds.get(artifact.artifactId)!,
      projectId: artifact.projectId,
      artifactKind: artifact.kind,
      artifactId: artifact.artifactId,
      artifactHash: artifact.contentHash,
      approvalReceiptId: `golden-approval-${artifact.kind}`,
      adoptedAt: "2026-08-31T08:00:00.000Z",
    }));
  return {
    approvals,
    adoptions,
    currentAdoptionReceipts: adoptions.map((adoption): AdoptionReceiptV3 => ({
      ...adoption,
      schemaVersion: "workflow-v3-adoption-receipt-v1",
      adoptedBy: "human",
    })),
  };
}

function evaluateGate(artifacts: ArtifactRecordV3[], verifications: VerificationReceiptV3[]) {
  return evaluateProductionGateV3({ artifacts, verifications, ...gateAuthority(artifacts, verifications) });
}

function evaluateInvalidContentCandidate(candidate: ArtifactRecordV3, expectedCheckCode: string) {
  const artifacts = withCandidate(activeArtifacts(), candidate);
  const receipt = verifyArtifactV3({
    artifact: candidate,
    artifacts,
    now: () => "2026-08-31T08:00:00.000Z",
    identity: () => "90000000-0000-4000-8000-000000000001",
  });
  const verifications = [
    ...activeVerifications().filter((existing) => existing.artifactId !== candidate.artifactId),
    receipt,
  ];
  const gate = evaluateGate(artifacts, verifications);

  expect(receipt.status).toBe("failed");
  expect(receipt.checks.filter((check) => !check.passed).map((check) => check.code)).toContain(expectedCheckCode);
  expect(gate.passed).toBe(false);
  expect(gate.blockers).toContainEqual(expect.objectContaining({
    code: "V3_VERIFICATION_NOT_PASSED",
    artifactId: candidate.artifactId,
  }));
  expect(artifacts.some((artifact) => artifact.kind === "generation-package")).toBe(false);
  return { artifacts, receipt, gate };
}

let databaseBefore: string | null;
let liveRunBefore: ReturnType<typeof directorySnapshot>;

beforeAll(() => {
  databaseBefore = fileHash(oldDatabasePath);
  liveRunBefore = directorySnapshot(liveRunRoot);
});

afterEach(() => {
  expect(JSON.stringify(golden)).toBe(goldenObjectSnapshot);
  expect(fs.readFileSync(goldenPath, "utf8")).toBe(goldenText);
});

afterAll(() => {
  expect(fileHash(oldDatabasePath)).toBe(databaseBefore);
  expect(directorySnapshot(liveRunRoot)).toEqual(liveRunBefore);
});

describe("workflow-v3 failure/chaos E2E from a sanitized real-model baseline", () => {
  it("recognizes the fixture as the immutable sanitized real-model success", () => {
    expect(golden.schemaVersion).toBe("workflow-v3-golden-baseline-v1");
    expect(golden.sourceLiveRunId).toBe("sanitized-real-model-e2e");
    expect(golden.artifacts.map((artifact) => artifact.kind)).toEqual([
      "source", "outline", "screenplay", "asset-bible", "shooting-script", "storyboard", "generation-package",
    ]);
    for (const artifact of golden.artifacts) {
      expect(contentHashV3(artifact.payload), artifact.kind).toBe(artifact.contentHash);
    }
    for (const kind of ["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"] as const) {
      const trace = (requireArtifact(golden.artifacts, kind).payload as { trace: { provider: string; eventTypes: string[] } }).trace;
      expect(trace.provider).toBe("codex-cli");
      expect(trace.eventTypes).toContain("turn.completed");
    }
    expect(evaluateGate(activeArtifacts(), activeVerifications())).toMatchObject({ passed: true, blockers: [] });
  });

  it("fails closed on a structured movement timeline that resumes after the arrival/stop gate", () => {
    const artifacts = activeArtifacts();
    const candidate = structuredClone(requireArtifact(artifacts, "shooting-script"));
    const raw = candidate.payload as { providerPayload: { shots: Array<{ id: string; physicalPlan: { timedStateGates: Array<{ stateId: string; eventFacts?: unknown[] }> } }> } };
    const shot = raw.providerPayload.shots.find((item) => item.id === "S002")!;
    const arrivalGate = shot.physicalPlan.timedStateGates.find((item) => item.stateId === "STATE-S002-ARRIVAL-DOOR-OPEN")!;
    arrivalGate.eventFacts ??= [];
    (arrivalGate.eventFacts as Array<Record<string, unknown>>).push({
      factId: "CHAOS-ARRIVAL-STOP",
      subjectType: "screenplay",
      subjectId: "CAMERA",
      property: "cameraMovementState",
      beforeValue: "moving",
      afterValue: "stopped-at-arrival",
    });
    candidate.contentHash = contentHashV3(candidate.payload);

    const { receipt } = evaluateInvalidContentCandidate(candidate, "V3_SHOOTING_MOVEMENT_TIMELINE_CONFLICT");
    expect(receipt.checks.find((check) => check.code === "V3_SHOOTING_MOVEMENT_TIMELINE_CONFLICT")?.evidence).toEqual([
      "S002:cameraMovementState:STATE-S002-ARRIVAL-DOOR-OPEN@6:stopped-at-arrival->cameraSegment[2]@6-8:continuous",
    ]);
  });

  it("fails closed when S001 plus S002 no longer equals the 15 second target", () => {
    const artifacts = activeArtifacts();
    const candidate = structuredClone(requireArtifact(artifacts, "shooting-script"));
    const payload = candidate.payload as { content: { shots: Array<{ displayId: string; durationSec: number }> } };
    payload.content.shots.find((shot) => shot.displayId === "S002")!.durationSec = 7;
    candidate.contentHash = contentHashV3(candidate.payload);

    const { receipt } = evaluateInvalidContentCandidate(candidate, "V3_SHOOTING_TARGET_DURATION_MATCH");
    expect(receipt.checks.find((check) => check.code === "V3_SHOOTING_TARGET_DURATION_MATCH")?.evidence).toEqual([
      "expected:15",
      "actual:14",
    ]);
  });

  it("fails closed when Storyboard shotUid no longer matches Shooting Script", () => {
    const artifacts = activeArtifacts();
    const candidate = structuredClone(requireArtifact(artifacts, "storyboard"));
    const payload = candidate.payload as { content: { frames: Array<{ shotUid: string }> } };
    payload.content.frames[0].shotUid = "90000000-0000-4000-8000-000000000002";
    candidate.contentHash = contentHashV3(candidate.payload);

    evaluateInvalidContentCandidate(candidate, "V3_STORYBOARD_ONE_TO_ONE_SHOT_COVERAGE");
  });

  it.each([
    ["missing inputArtifactId", (candidate: ArtifactRecordV3) => { candidate.inputArtifactIds = []; }],
    ["wrong input Artifact", (candidate: ArtifactRecordV3, artifacts: ArtifactRecordV3[]) => {
      candidate.inputArtifactIds = [
        requireArtifact(artifacts, "screenplay").artifactId,
        requireArtifact(artifacts, "asset-bible").artifactId,
      ];
    }],
  ])("fails closed on Artifact lineage: %s", (_label, inject) => {
    const artifacts = activeArtifacts();
    const candidate = structuredClone(requireArtifact(artifacts, "storyboard"));
    inject(candidate, artifacts);
    const mutated = withCandidate(artifacts, candidate);
    const gate = evaluateGate(mutated, activeVerifications());

    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContainEqual(expect.objectContaining({
      code: "V3_INPUT_CHAIN_MISMATCH",
      artifactId: candidate.artifactId,
    }));
    expect(mutated.some((artifact) => artifact.kind === "generation-package")).toBe(false);
  });

  it("fails closed when content changes but Artifact hash and receipt remain stale", () => {
    const artifacts = activeArtifacts();
    const candidate = structuredClone(requireArtifact(artifacts, "storyboard"));
    const originalHash = candidate.contentHash;
    const payload = candidate.payload as { content: { frames: Array<{ composition: string }> } };
    payload.content.frames[0].composition = `${payload.content.frames[0].composition} CHAOS-TAMPERED`;
    expect(candidate.contentHash).toBe(originalHash);
    expect(contentHashV3(candidate.payload)).not.toBe(originalHash);
    const mutated = withCandidate(artifacts, candidate);
    const verifications = activeVerifications();
    const verificationSnapshot = structuredClone(verifications);
    const gate = evaluateGate(mutated, verifications);

    expect(gate.passed).toBe(false);
    expect(gate.blockers).toContainEqual(expect.objectContaining({
      code: "V3_ARTIFACT_INTEGRITY_FAILED",
      artifactId: candidate.artifactId,
    }));
    expect(verifications).toEqual(verificationSnapshot);
    expect(mutated.some((artifact) => artifact.kind === "generation-package")).toBe(false);
  });

  it("has no repair, revision, review, regeneration, or model call in the failure path", () => {
    const failurePathSource = [
      fs.readFileSync(path.join(repositoryRoot, "src/workflow-v3/verification.ts"), "utf8"),
      fs.readFileSync(path.join(repositoryRoot, "src/workflow-v3/production-gate.ts"), "utf8"),
    ].join("\n");
    expect(failurePathSource).not.toContain("CodexCliProvider");
    expect(failurePathSource).not.toMatch(/\.(?:generateOutline|generateScreenplay|generateAssetBible|generateShootingScript|generateStoryboard|repairShootingScript|repairStoryboard|reviewContinuity)\s*\(/u);
    expect(failurePathSource).not.toMatch(/revision-service|project-service|approval-service|operation-runner|studio\.sqlite|project_heads|current_stage|stale_stages/iu);
  });
});
