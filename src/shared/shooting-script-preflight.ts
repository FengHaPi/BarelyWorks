import type { ShotSpec } from "./schemas";
import { H3_PRODUCT_DEFAULT_MAX_DURATION_SEC, H3_PRODUCT_MIN_DURATION_SEC } from "./h3-duration-policy";
import { inspectShotModelExecutability } from "./h3-executability";

export interface ShootingScriptPreflightIssue {
  code: string;
  message: string;
  affectedIds: string[];
  suggestedFix: string;
}

const openingPattern = /(?:门|闸)[^；。]*(?:打开|分离)|门缝/u;
const hiddenPattern = /(?:完全|始终)?(?:被门)?遮挡|不可见/u;
const revealPattern = /显露|露出|可见|看见/u;
const directConnectionPattern = /直接相连|无楼道|没有楼道|不存在楼道|无其他遮挡|没有其他遮挡/u;
const lowHoldPattern = /低位(?:持握|握持|持机)?/u;
const loweringActionPattern = /(?:降低|放低|下移|移至低位|低位持握|低位持机)/u;

function shotPhysicalText(shot: Pick<ShotSpec, "action" | "startState" | "endState" | "physicalPlan">): string {
  const plan = shot.physicalPlan;
  return [
    shot.action,
    shot.startState,
    shot.endState,
    ...(plan?.entities.map((entity) => entity.role) ?? []),
    ...(plan?.feasibilityNotes ?? []),
    ...(plan?.timedStateGates.flatMap((gate) => [gate.beforeState, gate.afterState]) ?? []),
  ].join("；");
}

export function inspectShootingScriptPreflight(
  shots: Array<Pick<ShotSpec, "id" | "startTimeSec" | "endTimeSec" | "durationSec" | "action" | "sound" | "startState" | "endState" | "physicalPlan"> & Partial<Pick<ShotSpec, "dialogue">>>,
  options: { recommendedMinimumShots?: number } = {},
): ShootingScriptPreflightIssue[] {
  const issues: ShootingScriptPreflightIssue[] = [];
  if (options.recommendedMinimumShots && shots.length < options.recommendedMinimumShots) {
    issues.push({
      code: "SHOOTING_SCRIPT_TOO_FEW_SHOTS_FOR_COMPLEXITY",
      message: `当前只有 ${shots.length} 个生产镜头，少于剧情复杂度建议的最低 ${options.recommendedMinimumShots} 个。`,
      affectedIds: shots.map((shot) => shot.id),
      suggestedFix: `按真实揭示和动作转折拆成至少 ${options.recommendedMinimumShots} 个镜头，使用整数秒并保持项目总时长不变。`,
    });
  }
  for (const shot of shots) {
    if (!Number.isInteger(shot.startTimeSec) || !Number.isInteger(shot.endTimeSec)) {
      issues.push({
        code: "SHOT_TIMECODE_NOT_INTEGER",
        message: `${shot.id} 的时间码为 ${shot.startTimeSec}–${shot.endTimeSec} 秒；起止时间不能含小数。`,
        affectedIds: [shot.id],
        suggestedFix: "重新分配相邻镜头时长，使所有起止点按整数秒连续衔接，并保持总时长不变。",
      });
    }
    if (!Number.isInteger(shot.durationSec)) {
      issues.push({
        code: "SHOT_DURATION_NOT_INTEGER",
        message: `${shot.id} 的时长为 ${shot.durationSec} 秒；镜头生产时长不能含小数。`,
        affectedIds: [shot.id],
        suggestedFix: "重新分配相邻镜头时长，使用整数秒并保持总时长不变，例如 15 秒可分为 8+7、9+6 或 5+5+5。",
      });
    }
    if (shot.durationSec < H3_PRODUCT_MIN_DURATION_SEC) {
      issues.push({
        code: "SHOT_DURATION_BELOW_PRODUCT_MIN",
        message: `${shot.id} 的时长为 ${shot.durationSec} 秒，低于产品规定的 ${H3_PRODUCT_MIN_DURATION_SEC} 秒。`,
        affectedIds: [shot.id],
        suggestedFix: `合并相邻连续内容或重新分配时间，确保每个镜头至少 ${H3_PRODUCT_MIN_DURATION_SEC} 秒，不得靠空等或重复动作凑时长。`,
      });
    }
    if (shot.durationSec > H3_PRODUCT_DEFAULT_MAX_DURATION_SEC) {
      issues.push({
        code: "SHOT_DURATION_ABOVE_PRODUCT_MAX",
        message: `${shot.id} 的时长为 ${shot.durationSec} 秒，超过当前 H3 单任务上限 ${H3_PRODUCT_DEFAULT_MAX_DURATION_SEC} 秒。`,
        affectedIds: [shot.id],
        suggestedFix: `在真实叙事转折或镜头调度节点拆分，确保每个镜头不超过 ${H3_PRODUCT_DEFAULT_MAX_DURATION_SEC} 秒。`,
      });
    }
    const plan = shot.physicalPlan;
    for (const problem of inspectShotModelExecutability(shot)) {
      if (problem.severity !== "error") continue;
      issues.push({
        code: problem.code,
        message: `${shot.id} AI 可执行性未通过：${problem.message}`,
        affectedIds: [shot.id],
        suggestedFix: problem.suggestedFix,
      });
    }
    if (!plan) continue;
    const context = shotPhysicalText(shot);
    if (directConnectionPattern.test(context)) {
      const gates = [...plan.timedStateGates].sort((left, right) => left.startsAtOffsetSec - right.startsAtOffsetSec);
      for (const revealGate of gates) {
        if (!hiddenPattern.test(revealGate.beforeState) || !revealPattern.test(revealGate.afterState)) continue;
        const openingGate = gates.find((candidate) => candidate.startsAtOffsetSec < revealGate.startsAtOffsetSec && openingPattern.test(candidate.afterState));
        if (!openingGate) continue;
        issues.push({
          code: "PHYSICAL_TIMED_GATE_EARLY_REVEAL",
          message: `${shot.id} 在 ${openingGate.startsAtOffsetSec} 秒开始开门，但又要求直连空间在 ${revealGate.startsAtOffsetSec} 秒前完全不可见；门缝形成后必然已经部分显露。`,
          affectedIds: [shot.id, openingGate.stateId, revealGate.stateId],
          suggestedFix: `把 ${openingGate.startsAtOffsetSec} 秒定义为空间首次部分显露，把 ${revealGate.startsAtOffsetSec} 秒改为主体首次清晰可辨，并同步 action、timedStateGates 与视线。`,
        });
        break;
      }
    }
  }

  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1];
    const current = shots[index];
    if (!previous.physicalPlan || !current.physicalPlan) continue;
    const previousText = shotPhysicalText(previous);
    const currentText = shotPhysicalText(current);
    const sharedPropIds = new Set(previous.physicalPlan.entities
      .map((entity) => entity.assetId)
      .filter((assetId): assetId is string => Boolean(assetId?.startsWith("PROP-"))));
    const changedProps = current.physicalPlan.entities
      .filter((entity) => entity.assetId && sharedPropIds.has(entity.assetId) && lowHoldPattern.test(entity.role))
      .map((entity) => entity.assetId as string);
    if (!changedProps.length || loweringActionPattern.test(previousText)) continue;
    issues.push({
      code: "PROP_POSITION_HANDOFF_DISCONTINUITY",
      message: `${previous.id} 到 ${current.id} 之间的 ${[...new Set(changedProps)].join("、")} 突然变成低位持握，但上一镜没有降低动作。`,
      affectedIds: [previous.id, current.id, ...new Set(changedProps)],
      suggestedFix: `让 ${current.id} 沿用 ${previous.id} 结束时的道具高度，或在 ${previous.id} 加入明确的降低动作和时间门禁。`,
    });
  }
  return issues;
}
