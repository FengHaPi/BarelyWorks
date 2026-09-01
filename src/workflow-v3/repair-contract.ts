import type { ShootingScriptContentV3 } from "./contracts";

export const NON_LOCAL_REPAIR_REQUIRED_V3 = "NON_LOCAL_REPAIR_REQUIRED" as const;
export const REPAIR_REGRESSION_V3 = "REGRESSION" as const;

const issueLeafPaths = {
  CAMERA_POSITION_MISMATCH: ["camera.position"],
  CAMERA_MOVEMENT_MISMATCH: ["camera.movement"],
  SHOT_ACTION_TIMING_MISMATCH: ["action"],
  SHOT_STATE_ORIENTATION_MISMATCH: ["startState", "endState"],
} as const satisfies Record<string, readonly string[]>;

type ReadyRepairContractV3 = {
  schemaVersion: "workflow-v3-repair-contract-v1";
  status: "READY";
  baselineArtifactId: string;
  baselineHash: string;
  baselineShotUids: string[];
  issues: Array<{ code: keyof typeof issueLeafPaths; affectedShotUids: string[]; allowedLeafPaths: string[] }>;
};

type RejectedRepairContractV3 = {
  schemaVersion: "workflow-v3-repair-contract-v1";
  status: "UNMAPPED_ISSUE" | "NON_LOCAL_REPAIR_REQUIRED" | "AFFECTED_ENTITY_NOT_FOUND";
  issueCodes: string[];
};

export type RepairContractV3 = ReadyRepairContractV3 | RejectedRepairContractV3;

export function createRepairContractV3(input: {
  baselineArtifactId: string;
  baselineHash: string;
  baseline: ShootingScriptContentV3;
  issues: Array<{ code: string; affectedShotUids: string[] }>;
}): RepairContractV3 {
  const baselineShotUids = input.baseline.shots.map((shot) => shot.shotUid);
  const baselineIds = new Set(baselineShotUids);
  const structuralIssueCodes = input.issues.filter((issue) => /(?:TOPOLOGY|SPLIT|MERGE|COVERAGE|ADD_SHOT|REMOVE_SHOT|REORDER)/u.test(issue.code));
  if (structuralIssueCodes.length) {
    return { schemaVersion: "workflow-v3-repair-contract-v1", status: NON_LOCAL_REPAIR_REQUIRED_V3, issueCodes: structuralIssueCodes.map((issue) => issue.code) };
  }
  const unmapped = input.issues.filter((issue) => !(issue.code in issueLeafPaths));
  if (unmapped.length) {
    return { schemaVersion: "workflow-v3-repair-contract-v1", status: "UNMAPPED_ISSUE", issueCodes: unmapped.map((issue) => issue.code) };
  }
  const missing = input.issues.filter((issue) => !issue.affectedShotUids.length || issue.affectedShotUids.some((id) => !baselineIds.has(id)));
  if (missing.length) {
    return { schemaVersion: "workflow-v3-repair-contract-v1", status: "AFFECTED_ENTITY_NOT_FOUND", issueCodes: missing.map((issue) => issue.code) };
  }
  return {
    schemaVersion: "workflow-v3-repair-contract-v1",
    status: "READY",
    baselineArtifactId: input.baselineArtifactId,
    baselineHash: input.baselineHash,
    baselineShotUids,
    issues: input.issues.map((issue) => ({
      code: issue.code as keyof typeof issueLeafPaths,
      affectedShotUids: [...new Set(issue.affectedShotUids)],
      allowedLeafPaths: [...issueLeafPaths[issue.code as keyof typeof issueLeafPaths]],
    })),
  };
}

function changedLeafPaths(baseline: unknown, candidate: unknown, parent = ""): string[] {
  if (Object.is(baseline, candidate)) return [];
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    if (baseline.length !== candidate.length) return [parent];
    return baseline.flatMap((value, index) => changedLeafPaths(value, candidate[index], parent ? `${parent}.${index}` : String(index)));
  }
  if (baseline && candidate && typeof baseline === "object" && typeof candidate === "object") {
    const baselineRecord = baseline as Record<string, unknown>;
    const candidateRecord = candidate as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(baselineRecord), ...Object.keys(candidateRecord)])].sort();
    return keys.flatMap((key) => changedLeafPaths(baselineRecord[key], candidateRecord[key], parent ? `${parent}.${key}` : key));
  }
  return [parent];
}

export function inspectShootingRepairV3(
  contract: RepairContractV3,
  baseline: ShootingScriptContentV3,
  candidate: ShootingScriptContentV3,
): { passed: boolean; code: "PASSED" | "UNMAPPED_ISSUE" | "AFFECTED_ENTITY_NOT_FOUND" | typeof NON_LOCAL_REPAIR_REQUIRED_V3 | typeof REPAIR_REGRESSION_V3; violations: string[] } {
  if (contract.status !== "READY") return { passed: false, code: contract.status, violations: contract.issueCodes };
  const baselineIds = baseline.shots.map((shot) => shot.shotUid);
  const candidateIds = candidate.shots.map((shot) => shot.shotUid);
  if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    return { passed: false, code: NON_LOCAL_REPAIR_REQUIRED_V3, violations: ["shots.identity-or-order"] };
  }
  const allowedByShot = new Map<string, Set<string>>();
  for (const issue of contract.issues) {
    for (const shotUid of issue.affectedShotUids) {
      const allowed = allowedByShot.get(shotUid) ?? new Set<string>();
      issue.allowedLeafPaths.forEach((leaf) => allowed.add(leaf));
      allowedByShot.set(shotUid, allowed);
    }
  }
  const candidateById = new Map(candidate.shots.map((shot) => [shot.shotUid, shot]));
  const violations: string[] = [];
  for (const shot of baseline.shots) {
    const replacement = candidateById.get(shot.shotUid)!;
    for (const path of changedLeafPaths(shot, replacement)) {
      if (path === "shotUid") {
        violations.push(`${shot.shotUid}.${path}`);
        continue;
      }
      if (!allowedByShot.get(shot.shotUid)?.has(path)) violations.push(`${shot.shotUid}.${path}`);
    }
  }
  return violations.length
    ? { passed: false, code: REPAIR_REGRESSION_V3, violations }
    : { passed: true, code: "PASSED", violations: [] };
}

export function issueLeafPathMapV3(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(issueLeafPaths).map(([code, paths]) => [code, [...paths]]));
}
