import { z } from "zod";

const intervalFields = {
  startOffsetSec: z.number().nonnegative(),
  endOffsetSec: z.number().positive(),
} as const;

const entityInstanceSchema = z.object({
  instanceId: z.string().trim().min(1),
  assetId: z.string().trim().min(1).nullable(),
  domain: z.enum(["real-space", "screen-space", "reflection-only"]),
  role: z.string().trim().min(1),
});

const cameraSegmentSchema = z.object({
  ...intervalFields,
  viewpoint: z.enum(["front", "rear", "profile", "over-shoulder", "point-of-view", "insert", "reflection-view", "other"]),
  screenDirection: z.string().trim().min(1),
  spaceId: z.string().trim().min(1).optional(),
  positionAnchor: z.string().trim().min(1).optional(),
  lookAt: z.string().trim().min(1).optional(),
  transitionFromPrevious: z.enum(["initial", "continuous", "boundary-crossing", "cut"]).optional(),
  boundaryId: z.string().trim().min(1).nullable().optional(),
  transitionPath: z.string().trim().min(1).nullable().optional(),
}).refine((value) => value.endOffsetSec > value.startOffsetSec, {
  message: "摄影机段落结束时间必须晚于开始时间",
  path: ["endOffsetSec"],
});

const subjectOrientationSchema = z.object({
  ...intervalFields,
  instanceId: z.string().trim().min(1),
  bodyFaces: z.string().trim().min(1),
  headFaces: z.string().trim().min(1),
  gazeTarget: z.string().trim().min(1),
}).refine((value) => value.endOffsetSec > value.startOffsetSec, {
  message: "人物朝向段落结束时间必须晚于开始时间",
  path: ["endOffsetSec"],
});

const displayRelationSchema = z.object({
  ...intervalFields,
  propId: z.string().trim().min(1),
  holderInstanceId: z.string().trim().min(1).nullable(),
  surfaceType: z.enum(["single-sided", "dual-sided", "unknown"]),
  interactionMode: z.enum(["user-reading", "presenting-to-camera", "not-in-use", "other"]),
  displayFaces: z.enum(["holder", "camera", "other-subject", "away"]),
  visibleToInstanceIds: z.array(z.string().trim().min(1)),
  cameraReadable: z.boolean(),
  readabilityMethod: z.enum(["not-required", "over-shoulder", "side-angle", "insert", "reflection", "intentional-presentation", "other"]),
}).refine((value) => value.endOffsetSec > value.startOffsetSec, {
  message: "显示面关系结束时间必须晚于开始时间",
  path: ["endOffsetSec"],
});

const reflectionRelationSchema = z.object({
  surfaceId: z.string().trim().min(1),
  normalReflectionPairs: z.array(z.object({
    realInstanceId: z.string().trim().min(1),
    reflectionInstanceId: z.string().trim().min(1),
  })),
  mirrorOnlyInstanceIds: z.array(z.string().trim().min(1)),
  realSpaceInstanceIds: z.array(z.string().trim().min(1)),
  boundaryVisibleInFrame: z.boolean(),
});

const timedStateGateSchema = z.object({
  stateId: z.string().trim().min(1),
  startsAtOffsetSec: z.number().nonnegative(),
  beforeState: z.string().trim().min(1),
  afterState: z.string().trim().min(1),
  noEarlyOccurrence: z.boolean(),
});

export const shotPhysicalPlanSchema = z.object({
  schemaVersion: z.literal("shot-physical-plan-v1"),
  cameraContinuityMode: z.enum(["single-take", "intentional-cuts"]).optional(),
  spaceTopology: z.object({
    spaces: z.array(z.object({
      spaceId: z.string().trim().min(1),
      label: z.string().trim().min(1),
    })).min(1),
    boundaries: z.array(z.object({
      boundaryId: z.string().trim().min(1),
      fromSpaceId: z.string().trim().min(1),
      toSpaceId: z.string().trim().min(1),
      traversalAllowed: z.boolean(),
      label: z.string().trim().min(1),
    })),
  }).optional(),
  applicability: z.object({
    displaySurfaces: z.boolean(),
    reflectiveSurfaces: z.boolean(),
    delayedStateChanges: z.boolean(),
  }),
  entities: z.array(entityInstanceSchema).min(1),
  cameraSegments: z.array(cameraSegmentSchema).min(1),
  subjectOrientations: z.array(subjectOrientationSchema),
  displayRelations: z.array(displayRelationSchema),
  reflectionRelations: z.array(reflectionRelationSchema),
  timedStateGates: z.array(timedStateGateSchema),
  feasibilityNotes: z.array(z.string().trim().min(1)),
});

export type ShotPhysicalPlan = z.infer<typeof shotPhysicalPlanSchema>;

export interface PhysicalPlanProblem {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface PhysicalVerificationLike {
  cameraBlocking: "pass" | "fail";
  displayGeometry: "pass" | "fail" | "not-applicable";
  reflectionTopology: "pass" | "fail" | "not-applicable";
  timedStateGates: "pass" | "fail" | "not-applicable";
  notes: string[];
}

function intervalsOverlap(left: { startOffsetSec: number; endOffsetSec: number }, right: { startOffsetSec: number; endOffsetSec: number }): boolean {
  return left.startOffsetSec < right.endOffsetSec && right.startOffsetSec < left.endOffsetSec;
}

export function inspectPhysicalPlan(
  plan: ShotPhysicalPlan,
  durationSec: number,
  characterIds: string[],
  propIds: string[],
): PhysicalPlanProblem[] {
  const problems: PhysicalPlanProblem[] = [];
  const error = (code: string, message: string) => problems.push({ severity: "error", code, message });
  const warning = (code: string, message: string) => problems.push({ severity: "warning", code, message });
  const tolerance = 0.001;
  const entitiesById = new Map(plan.entities.map((entity) => [entity.instanceId, entity]));
  if (entitiesById.size !== plan.entities.length) error("PHYSICAL_ENTITY_INSTANCE_DUPLICATE", "physicalPlan.entities 的 instanceId 必须唯一");

  for (const characterId of characterIds) {
    if (!plan.entities.some((entity) => entity.assetId === characterId)) {
      error("PHYSICAL_CHARACTER_INSTANCE_MISSING", `角色资产 ${characterId} 没有对应的物理实例`);
    }
  }

  const cameraSegments = [...plan.cameraSegments].sort((left, right) => left.startOffsetSec - right.startOffsetSec);
  if (Math.abs((cameraSegments[0]?.startOffsetSec ?? -1) - 0) > tolerance) {
    error("PHYSICAL_CAMERA_COVERAGE_GAP", "摄影机段落必须从镜头相对 0 秒开始");
  }
  cameraSegments.forEach((segment, index) => {
    if (segment.endOffsetSec > durationSec + tolerance) error("PHYSICAL_CAMERA_OUT_OF_RANGE", "摄影机段落超出镜头时长");
    if (index > 0 && Math.abs(segment.startOffsetSec - cameraSegments[index - 1].endOffsetSec) > tolerance) {
      error("PHYSICAL_CAMERA_COVERAGE_GAP", "摄影机段落必须连续且不得重叠");
    }
  });
  if (Math.abs((cameraSegments.at(-1)?.endOffsetSec ?? -1) - durationSec) > tolerance) {
    error("PHYSICAL_CAMERA_COVERAGE_GAP", "摄影机段落必须覆盖到镜头结束时间");
  }

  for (const orientation of plan.subjectOrientations) {
    if (!entitiesById.has(orientation.instanceId)) error("PHYSICAL_ORIENTATION_ENTITY_UNKNOWN", `朝向计划引用未知实例 ${orientation.instanceId}`);
    if (orientation.endOffsetSec > durationSec + tolerance) error("PHYSICAL_ORIENTATION_OUT_OF_RANGE", `实例 ${orientation.instanceId} 的朝向时间超出镜头时长`);
  }
  for (const entity of plan.entities.filter((item) => item.domain === "real-space" && item.assetId && characterIds.includes(item.assetId))) {
    if (!plan.subjectOrientations.some((orientation) => orientation.instanceId === entity.instanceId)) {
      error("PHYSICAL_ORIENTATION_MISSING", `现实人物实例 ${entity.instanceId} 缺少身体、头部和视线朝向计划`);
    }
  }
  for (let index = 0; index < plan.subjectOrientations.length; index += 1) {
    const current = plan.subjectOrientations[index];
    for (const next of plan.subjectOrientations.slice(index + 1)) {
      if (current.instanceId !== next.instanceId || !intervalsOverlap(current, next)) continue;
      if (current.bodyFaces !== next.bodyFaces || current.headFaces !== next.headFaces || current.gazeTarget !== next.gazeTarget) {
        error("PHYSICAL_ORIENTATION_OVERLAP_CONFLICT", `实例 ${current.instanceId} 在重叠时段存在互相矛盾的朝向`);
      }
    }
  }

  if (plan.applicability.displaySurfaces !== Boolean(plan.displayRelations.length)) {
    error("PHYSICAL_DISPLAY_APPLICABILITY_CONFLICT", "显示面适用性声明与 displayRelations 数量不一致");
  }
  for (const relation of plan.displayRelations) {
    if (!propIds.includes(relation.propId)) error("PHYSICAL_DISPLAY_PROP_UNKNOWN", `显示面引用的道具 ${relation.propId} 不在本镜头 propIds 中`);
    if (relation.endOffsetSec > durationSec + tolerance) error("PHYSICAL_DISPLAY_OUT_OF_RANGE", `道具 ${relation.propId} 的显示面时间超出镜头时长`);
    const holder = relation.holderInstanceId ? entitiesById.get(relation.holderInstanceId) : null;
    if (relation.holderInstanceId && !holder) error("PHYSICAL_DISPLAY_HOLDER_UNKNOWN", `显示面引用未知持有者 ${relation.holderInstanceId}`);
    for (const viewerId of relation.visibleToInstanceIds) {
      if (!entitiesById.has(viewerId)) error("PHYSICAL_DISPLAY_VIEWER_UNKNOWN", `显示面可见对象引用未知实例 ${viewerId}`);
    }
    if (relation.interactionMode === "user-reading") {
      if (!relation.holderInstanceId) error("PHYSICAL_DISPLAY_READER_MISSING", `道具 ${relation.propId} 声明为用户读取，但没有持有者`);
      if (relation.displayFaces !== "holder") error("PHYSICAL_DISPLAY_FACING_CONFLICT", `道具 ${relation.propId} 供持有者读取时，显示面必须朝向持有者`);
      if (relation.holderInstanceId && !relation.visibleToInstanceIds.includes(relation.holderInstanceId)) {
        error("PHYSICAL_DISPLAY_VISIBILITY_CONFLICT", `道具 ${relation.propId} 的持有者未被列为可见显示内容的对象`);
      }
    }
    if (relation.interactionMode === "presenting-to-camera" && relation.displayFaces !== "camera") {
      error("PHYSICAL_DISPLAY_FACING_CONFLICT", `道具 ${relation.propId} 主动展示给镜头时，显示面必须朝向摄影机`);
    }
    if (relation.cameraReadable && relation.readabilityMethod === "not-required") {
      error("PHYSICAL_DISPLAY_CAMERA_METHOD_MISSING", `道具 ${relation.propId} 要求摄影机读屏，但没有可执行的读屏机位`);
    }
    if (!relation.cameraReadable && relation.readabilityMethod !== "not-required") {
      error("PHYSICAL_DISPLAY_CAMERA_METHOD_CONFLICT", `道具 ${relation.propId} 不要求摄影机读屏，却声明了读屏机位`);
    }
    if (relation.surfaceType === "single-sided" && relation.displayFaces === "camera" && relation.holderInstanceId && relation.visibleToInstanceIds.includes(relation.holderInstanceId)) {
      error("PHYSICAL_DISPLAY_SINGLE_SIDE_IMPOSSIBLE", `单面显示道具 ${relation.propId} 不可能同时朝向摄影机并被持有者直接读取`);
    }
    if (relation.cameraReadable) {
      const overlappingViews = cameraSegments.filter((segment) => intervalsOverlap(segment, relation)).map((segment) => segment.viewpoint);
      const requiredViewpoint = relation.readabilityMethod === "over-shoulder"
        ? "over-shoulder"
        : relation.readabilityMethod === "side-angle"
          ? "profile"
          : relation.readabilityMethod === "insert"
            ? "insert"
            : relation.readabilityMethod === "reflection"
              ? "reflection-view"
              : null;
      if (requiredViewpoint && !overlappingViews.includes(requiredViewpoint)) {
        error("PHYSICAL_DISPLAY_CAMERA_VIEW_CONFLICT", `道具 ${relation.propId} 的读屏方式 ${relation.readabilityMethod} 与同期摄影机视点不一致`);
      }
      if (relation.readabilityMethod === "intentional-presentation" && (relation.interactionMode !== "presenting-to-camera" || relation.displayFaces !== "camera")) {
        error("PHYSICAL_DISPLAY_PRESENTATION_CONFLICT", `道具 ${relation.propId} 只有在剧情明确主动展示时才能用正面镜头读屏`);
      }
      if (relation.readabilityMethod === "other") warning("PHYSICAL_DISPLAY_CAMERA_METHOD_UNVERIFIED", `道具 ${relation.propId} 的自定义读屏方式需要人工确认物理可行性`);
    }
  }

  if (plan.applicability.reflectiveSurfaces !== Boolean(plan.reflectionRelations.length)) {
    error("PHYSICAL_REFLECTION_APPLICABILITY_CONFLICT", "反射面适用性声明与 reflectionRelations 数量不一致");
  }
  for (const relation of plan.reflectionRelations) {
    const mirrorOnly = new Set(relation.mirrorOnlyInstanceIds);
    const realSpace = new Set(relation.realSpaceInstanceIds);
    for (const instanceId of [...mirrorOnly, ...realSpace]) {
      if (!entitiesById.has(instanceId)) error("PHYSICAL_REFLECTION_ENTITY_UNKNOWN", `反射关系引用未知实例 ${instanceId}`);
    }
    for (const instanceId of mirrorOnly) {
      if (realSpace.has(instanceId)) error("PHYSICAL_REFLECTION_DOMAIN_CONFLICT", `实例 ${instanceId} 不能同时只存在于镜面和现实空间`);
      if (entitiesById.get(instanceId)?.domain !== "reflection-only") error("PHYSICAL_REFLECTION_DOMAIN_CONFLICT", `镜面独有实例 ${instanceId} 的 domain 必须为 reflection-only`);
    }
    for (const instanceId of realSpace) {
      if (entitiesById.get(instanceId)?.domain !== "real-space") error("PHYSICAL_REFLECTION_DOMAIN_CONFLICT", `现实实例 ${instanceId} 的 domain 必须为 real-space`);
    }
    for (const pair of relation.normalReflectionPairs) {
      if (entitiesById.get(pair.realInstanceId)?.domain !== "real-space") error("PHYSICAL_NORMAL_REFLECTION_INVALID", `正常镜像来源 ${pair.realInstanceId} 必须是现实实例`);
      if (entitiesById.get(pair.reflectionInstanceId)?.domain !== "reflection-only") error("PHYSICAL_NORMAL_REFLECTION_INVALID", `正常镜像 ${pair.reflectionInstanceId} 必须是 reflection-only 实例`);
      if (mirrorOnly.has(pair.reflectionInstanceId)) error("PHYSICAL_REFLECTION_ROLE_CONFLICT", `正常镜像 ${pair.reflectionInstanceId} 不能同时作为异常镜面独有实体`);
    }
    if (mirrorOnly.size && !relation.boundaryVisibleInFrame) {
      error("PHYSICAL_REFLECTION_BOUNDARY_MISSING", `反射面 ${relation.surfaceId} 含镜面独有实体时，画面必须保留镜面边界和现实空间作为证据`);
    }
  }

  if (plan.applicability.delayedStateChanges !== Boolean(plan.timedStateGates.length)) {
    error("PHYSICAL_TIMED_GATE_APPLICABILITY_CONFLICT", "延迟状态变化声明与 timedStateGates 数量不一致");
  }
  for (const gate of plan.timedStateGates) {
    if (gate.startsAtOffsetSec > durationSec + tolerance) error("PHYSICAL_TIMED_GATE_OUT_OF_RANGE", `状态 ${gate.stateId} 的开始时间超出镜头时长`);
    if (!gate.noEarlyOccurrence) error("PHYSICAL_TIMED_GATE_EARLY_OCCURRENCE_UNGUARDED", `状态 ${gate.stateId} 必须明确禁止在 ${gate.startsAtOffsetSec} 秒前出现`);
    if (gate.beforeState === gate.afterState) error("PHYSICAL_TIMED_GATE_NO_CHANGE", `状态 ${gate.stateId} 的变化前后描述不能相同`);
  }

  return problems;
}

export function inspectPhysicalVerification(
  plan: ShotPhysicalPlan,
  verification: PhysicalVerificationLike | null | undefined,
): PhysicalPlanProblem[] {
  if (!verification) return [{ severity: "error", code: "PHYSICAL_STORYBOARD_VERIFICATION_MISSING", message: "分镜缺少 physicalVerification，不能确认机位和空间关系可执行" }];
  const problems: PhysicalPlanProblem[] = [];
  if (verification.cameraBlocking === "fail") {
    problems.push({ severity: "error", code: "PHYSICAL_CAMERA_BLOCKING_FAILED", message: "分镜已标记摄影机调度不可执行" });
  }
  const checks = [
    { applicable: plan.applicability.displaySurfaces, value: verification.displayGeometry, code: "PHYSICAL_DISPLAY_STORYBOARD_FAILED", label: "显示面几何" },
    { applicable: plan.applicability.reflectiveSurfaces, value: verification.reflectionTopology, code: "PHYSICAL_REFLECTION_STORYBOARD_FAILED", label: "反射拓扑" },
    { applicable: plan.applicability.delayedStateChanges, value: verification.timedStateGates, code: "PHYSICAL_TIMED_GATE_STORYBOARD_FAILED", label: "延迟状态门" },
  ] as const;
  for (const check of checks) {
    if (!check.applicable && check.value !== "not-applicable") {
      problems.push({ severity: "error", code: `${check.code}_APPLICABILITY`, message: `${check.label}不适用时，分镜必须标记 not-applicable` });
    } else if (check.applicable && check.value === "not-applicable") {
      problems.push({ severity: "error", code: `${check.code}_APPLICABILITY`, message: `${check.label}已在 physicalPlan 中声明适用，分镜不能跳过核验` });
    } else if (check.applicable && check.value === "fail") {
      problems.push({ severity: "error", code: check.code, message: `分镜已标记${check.label}核验失败` });
    }
  }
  return problems;
}
