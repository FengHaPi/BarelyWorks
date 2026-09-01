import { randomUUID } from "node:crypto";
import type {
  ArtifactRecordV3,
  GenerationPackageContentV3,
  ShootingScriptContentV3,
  StoryboardContentV3,
  VerificationCheckV3,
  VerificationReceiptV3,
} from "./contracts";

function check(code: string, passed: boolean, evidence: string[]): VerificationCheckV3 {
  return { code, passed, evidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shootingTargetDuration(payload: unknown): number | null {
  if (!isRecord(payload) || !isRecord(payload.providerPayload)) return null;
  const target = payload.providerPayload.targetDurationSec;
  return typeof target === "number" && Number.isFinite(target) && target > 0 ? target : null;
}

const deterministicCameraStopStates = new Set(["stopped", "stationary", "halted", "stopped-at-arrival"]);

function shootingMovementTimelineConflicts(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.providerPayload) || !Array.isArray(payload.providerPayload.shots)) return [];
  const conflicts: string[] = [];
  for (const rawShot of payload.providerPayload.shots) {
    if (!isRecord(rawShot) || typeof rawShot.id !== "string" || !isRecord(rawShot.physicalPlan)
      || !Array.isArray(rawShot.physicalPlan.timedStateGates)
      || !Array.isArray(rawShot.physicalPlan.cameraSegments)) continue;
    for (const rawGate of rawShot.physicalPlan.timedStateGates) {
      if (!isRecord(rawGate) || typeof rawGate.stateId !== "string" || typeof rawGate.startsAtOffsetSec !== "number"
        || !Array.isArray(rawGate.eventFacts)) continue;
      const gateOffsetSec = rawGate.startsAtOffsetSec;
      for (const rawFact of rawGate.eventFacts) {
        if (!isRecord(rawFact)
          || typeof rawFact.property !== "string"
          || typeof rawFact.afterValue !== "string"
          || rawFact.property !== "cameraMovementState"
          || !deterministicCameraStopStates.has(rawFact.afterValue)) continue;
        rawShot.physicalPlan.cameraSegments.forEach((rawSegment, index) => {
          if (!isRecord(rawSegment)
            || typeof rawSegment.startOffsetSec !== "number"
            || typeof rawSegment.endOffsetSec !== "number"
            || typeof rawSegment.transitionFromPrevious !== "string"
            || typeof rawSegment.transitionPath !== "string") return;
          const explicitlyMoving = ["continuous", "boundary-crossing"].includes(rawSegment.transitionFromPrevious)
            && rawSegment.transitionPath.trim().length > 0;
          if (!explicitlyMoving || rawSegment.endOffsetSec <= gateOffsetSec
            || rawSegment.startOffsetSec < gateOffsetSec) return;
          conflicts.push(`${rawShot.id}:cameraMovementState:${rawGate.stateId}@${gateOffsetSec}:${rawFact.afterValue}`
            + `->cameraSegment[${index}]@${rawSegment.startOffsetSec}-${rawSegment.endOffsetSec}:${rawSegment.transitionFromPrevious}`);
        });
      }
    }
  }
  return conflicts.sort();
}

export function verifyArtifactV3(input: {
  artifact: ArtifactRecordV3;
  artifacts: ArtifactRecordV3[];
  now: () => string;
  identity?: () => string;
}): VerificationReceiptV3 {
  const checks: VerificationCheckV3[] = [
    check("V3_INPUTS_EXIST", input.artifact.inputArtifactIds.every((id) => input.artifacts.some((artifact) => artifact.artifactId === id)), input.artifact.inputArtifactIds),
  ];
  if (input.artifact.kind === "source") {
    const payload = input.artifact.payload as { content: { text: string } };
    checks.push(check("V3_SOURCE_NON_EMPTY", Boolean(payload.content.text.trim()), [`length:${payload.content.text.length}`]));
  }
  if (input.artifact.kind === "shooting-script") {
    const payload = input.artifact.payload as { content: ShootingScriptContentV3 };
    const ids = payload.content.shots.map((shot) => shot.shotUid);
    const displayIds = payload.content.shots.map((shot) => shot.displayId);
    const targetDurationSec = shootingTargetDuration(input.artifact.payload);
    const actualDurationSec = payload.content.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
    const movementTimelineConflicts = shootingMovementTimelineConflicts(input.artifact.payload);
    checks.push(check("V3_SHOT_UID_UNIQUE", new Set(ids).size === ids.length, ids));
    checks.push(check("V3_DISPLAY_ID_UNIQUE", new Set(displayIds).size === displayIds.length, displayIds));
    checks.push(check(
      "V3_SHOOTING_TARGET_DURATION_MATCH",
      targetDurationSec !== null && Math.abs(targetDurationSec - actualDurationSec) <= 0.001,
      [`expected:${targetDurationSec ?? "missing"}`, `actual:${actualDurationSec}`],
    ));
    checks.push(check(
      "V3_SHOOTING_MOVEMENT_TIMELINE_CONFLICT",
      movementTimelineConflicts.length === 0,
      movementTimelineConflicts,
    ));
  }
  if (input.artifact.kind === "storyboard") {
    const payload = input.artifact.payload as { content: StoryboardContentV3 };
    const shootingArtifact = input.artifacts.find((artifact) => artifact.artifactId === input.artifact.inputArtifactIds[0]);
    const shooting = shootingArtifact?.payload as { content?: ShootingScriptContentV3 } | undefined;
    const expected = shooting?.content?.shots.map((shot) => shot.shotUid) ?? [];
    const actual = payload.content.frames.map((frame) => frame.shotUid);
    checks.push(check("V3_STORYBOARD_ONE_TO_ONE_SHOT_COVERAGE", JSON.stringify(actual) === JSON.stringify(expected), [`expected:${expected.join(",")}`, `actual:${actual.join(",")}`]));
  }
  if (input.artifact.kind === "generation-package") {
    const payload = input.artifact.payload as { content: GenerationPackageContentV3 };
    const shootingArtifact = input.artifacts.find((artifact) => artifact.kind === "shooting-script");
    const shooting = shootingArtifact?.payload as { content?: ShootingScriptContentV3 } | undefined;
    const expected = shooting?.content?.shots.map((shot) => shot.shotUid) ?? [];
    const actual = payload.content.tasks.map((task) => task.shotUid);
    checks.push(check("V3_PACKAGE_ONE_TASK_PER_SHOT", JSON.stringify(actual) === JSON.stringify(expected), [`expected:${expected.join(",")}`, `actual:${actual.join(",")}`]));
    checks.push(check("V3_PACKAGE_PROVENANCE_COMPLETE", payload.content.sourceArtifactIds.every((id) => input.artifact.inputArtifactIds.includes(id)), payload.content.sourceArtifactIds));
  }
  const status = checks.every((item) => item.passed) ? "passed" : "failed";
  return Object.freeze({
    schemaVersion: "workflow-v3-verification-v1",
    receiptId: (input.identity ?? randomUUID)(),
    artifactId: input.artifact.artifactId,
    artifactHash: input.artifact.contentHash,
    verifierId: "workflow-v3-deterministic-verifier",
    verifierVersion: "1",
    status,
    checks,
    createdAt: input.now(),
  });
}
