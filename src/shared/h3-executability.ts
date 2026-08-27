import type { ShotSpec } from "./schemas";

export const H3_EXECUTION_POLICY_VERSION = "model-executability-v3";

export interface H3ExecutabilityIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  suggestedFix: string;
}

export interface ShotComplexityReport {
  policyVersion: typeof H3_EXECUTION_POLICY_VERSION;
  status: "ready" | "blocked";
  estimatedMajorBeats: number;
  maximumMajorBeats: number;
  cameraPhases: number;
  timedStateGates: number;
  preciseTimeAnchors: number;
  highRiskLayers: string[];
  issues: H3ExecutabilityIssue[];
}

const screenDetailPattern = /(?:屏幕|手机|通话)[^；。\n]{0,80}(?:冻结|压缩块|断字|音画错位|故障画面)|(?:冻结|压缩块|断字|音画错位)[^；。\n]{0,80}(?:屏幕|手机|通话)/u;
const unreadableScreenPattern = /(?:不再|无法|不能)[^；。\n]{0,30}(?:正面)?(?:读取|读屏|看清)|仅从[^；。\n]{0,30}(?:斜侧|边缘)/u;
const crowdPattern = /(?:复制体|分身|克隆|相同人物)[^；。\n]{0,80}(?:群体|人群|密集|挤满|大量|所有)|(?:群体|人群|密集|挤满|大量|所有)[^；。\n]{0,80}(?:复制体|分身|克隆|相同人物)/u;
const connectedSpacePattern = /(?:另一|第二)[^；。\n]{0,20}(?:电梯|轿厢|房间|空间)|(?:无缝|直接)[^；。\n]{0,20}(?:相接|相连|连接)/u;
const mirrorPattern = /镜(?:中|内|面|像)|反射/u;
const movementPattern = /跟拍|绕(?:行|至|到|人物)?|环绕|横移|平移|滑(?:入|向|至|到)|推进|推近|后撤|拉远|摇镜|升降/u;

function parseClock(token: string): number | null {
  const normalized = token.trim();
  if (normalized.includes(":")) {
    const [minutes, seconds] = normalized.split(":").map(Number);
    return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : null;
  }
  const value = Number(normalized.replace(/秒$/u, ""));
  return Number.isFinite(value) ? value : null;
}

function soundConflict(texts: string[]): H3ExecutabilityIssue | null {
  const ranges: Array<{ start: number; end: number; source: string }> = [];
  const stops: Array<{ at: number; source: string }> = [];
  const clock = "(?:\\d{1,2}:)?\\d+(?:\\.\\d+)?";
  const rangePattern = new RegExp(`(${clock})\\s*(?:秒)?\\s*(?:—|–|-|至|到)\\s*(${clock})\\s*(?:秒)?`, "u");
  const instantPattern = new RegExp(`(${clock})\\s*(?:秒)?`, "u");
  for (const text of texts) {
    const source = text.match(/AUDIO-\d+/u)?.[0] ?? "generic";
    const range = text.match(rangePattern);
    if (range && /持续|保持|贯穿|维持/u.test(text)) {
      const start = parseClock(range[1]);
      const end = parseClock(range[2]);
      if (start != null && end != null) ranges.push({ start, end, source });
    }
    if (/抽空|停止|消失|归零|切断|不再恢复/u.test(text)) {
      const instant = text.match(instantPattern);
      const at = instant ? parseClock(instant[1]) : null;
      if (at != null) stops.push({ at, source });
    }
  }
  const conflict = ranges.find((range) => stops.some((stop) =>
    (range.source === stop.source || range.source === "generic" || stop.source === "generic")
    && stop.at >= range.start && stop.at < range.end - 0.001));
  if (!conflict) return null;
  return {
    severity: "error",
    code: "H3_SOUND_TIMELINE_CONFLICT",
    message: "同一声音既被要求持续到较晚时刻，又在此前停止或抽空，时间线互相冲突。",
    suggestedFix: "把声音写成一条不重叠时间线：停止时刻之前持续，停止后保持安静。",
  };
}

function textFromShot(shot: Pick<ShotSpec, "action" | "sound" | "startState" | "endState" | "physicalPlan">): string {
  const plan = shot.physicalPlan;
  return [
    shot.action,
    ...(shot.sound ?? []),
    shot.startState,
    shot.endState,
    ...(plan?.entities.map((entity) => entity.role) ?? []),
    ...(plan?.feasibilityNotes ?? []),
    ...(plan?.timedStateGates.flatMap((gate) => [gate.beforeState, gate.afterState]) ?? []),
  ].join("；");
}

function preciseTimes(text: string): number[] {
  const values = [...text.matchAll(/(?<![\w-])((?:\d{1,2}:)?\d+(?:\.\d+)?)\s*(?:秒)?(?=\s*(?:—|–|-|至|到|：|:|时|，|,))/gu)]
    .map((match) => parseClock(match[1]))
    .filter((value): value is number => value != null);
  return [...new Set(values.map((value) => Number(value.toFixed(3))))];
}

function estimateMajorBeats(shot: Pick<ShotSpec, "action" | "dialogue" | "physicalPlan">): number {
  const timeAnchors = preciseTimes(shot.action).length;
  const proseEvents = shot.action.split(/[。；\n]+/u).filter((part) => part.trim().length >= 8).length;
  const stateChanges = shot.physicalPlan?.timedStateGates?.length ?? 0;
  return Math.max(1, timeAnchors, proseEvents, Math.ceil(stateChanges / 2), shot.dialogue.length);
}

export function analyzeShotComplexity(shot: Pick<ShotSpec, "durationSec" | "action" | "dialogue" | "sound" | "startState" | "endState" | "physicalPlan">): ShotComplexityReport {
  const plan = shot.physicalPlan;
  const text = textFromShot(shot);
  const maximumMajorBeats = shot.durationSec <= 6 ? 3 : 4;
  const estimatedMajorBeats = estimateMajorBeats(shot);
  const highRiskLayers = [
    plan?.applicability?.displaySurfaces || screenDetailPattern.test(text) ? "屏幕" : null,
    plan?.applicability?.reflectiveSurfaces || mirrorPattern.test(text) ? "镜面" : null,
    crowdPattern.test(text) ? "多复制体群体" : null,
    connectedSpacePattern.test(text) ? "反常直连空间" : null,
  ].filter((value): value is string => Boolean(value));
  const issues = inspectShotModelExecutabilityInternal(shot, {
    maximumMajorBeats,
    estimatedMajorBeats,
    highRiskLayers,
  });
  return {
    policyVersion: H3_EXECUTION_POLICY_VERSION,
    status: issues.some((issue) => issue.severity === "error") ? "blocked" : "ready",
    estimatedMajorBeats,
    maximumMajorBeats,
    cameraPhases: plan?.cameraSegments?.length ?? 0,
    timedStateGates: plan?.timedStateGates?.length ?? 0,
    preciseTimeAnchors: preciseTimes(shot.action).length,
    highRiskLayers,
    issues,
  };
}

export function inspectShotModelExecutability(
  shot: Pick<ShotSpec, "durationSec" | "action" | "sound" | "startState" | "endState" | "physicalPlan"> & Partial<Pick<ShotSpec, "dialogue">>,
): H3ExecutabilityIssue[] {
  return analyzeShotComplexity({ ...shot, dialogue: shot.dialogue ?? [] }).issues;
}

function inspectShotModelExecutabilityInternal(
  shot: Pick<ShotSpec, "durationSec" | "action" | "dialogue" | "sound" | "startState" | "endState" | "physicalPlan">,
  analysis: { maximumMajorBeats: number; estimatedMajorBeats: number; highRiskLayers: string[] },
): H3ExecutabilityIssue[] {
  const issues: H3ExecutabilityIssue[] = [];
  const plan = shot.physicalPlan;
  const text = textFromShot(shot);
  if (!plan) return issues;

  const cameraSegments = plan.cameraSegments ?? [];
  const timedStateGates = plan.timedStateGates ?? [];
  const displayRelations = plan.displayRelations ?? [];
  if (analysis.estimatedMajorBeats > analysis.maximumMajorBeats) {
    issues.push({
      severity: "error",
      code: "H3_MAJOR_BEAT_OVERLOAD",
      message: `单镜头预计包含 ${analysis.estimatedMajorBeats} 个主要可见剧情 Beat，超过 ${shot.durationSec} 秒镜头的可靠预算 ${analysis.maximumMajorBeats} 个。`,
      suggestedFix: "在真实揭示、空间变化或动作转折处拆成相邻镜头；不要通过减少文字但保留全部事件来规避检查。",
    });
  }
  if (cameraSegments.length > 3) {
    issues.push({
      severity: "error",
      code: "H3_CAMERA_PHASE_OVERLOAD",
      message: `单镜头包含 ${cameraSegments.length} 段机位变化，超过模型稳定执行预算 3 段。`,
      suggestedFix: "压缩为“跟入/建立—一次横移或定机—结尾一次轻微移动”，否则在真实叙事转折处拆镜。",
    });
  }

  const topology = plan.spaceTopology;
  if (!plan.cameraContinuityMode || !topology) {
    issues.push({
      severity: "error",
      code: "H3_CAMERA_SPACE_TOPOLOGY_MISSING",
      message: "physicalPlan 没有声明摄影连续模式与空间拓扑，无法判断摄影机是在连续移动、穿过真实边界，还是发生了空间瞬移。",
      suggestedFix: "在 physicalPlan 填写 cameraContinuityMode、spaceTopology，并为每个 cameraSegments 段落填写 spaceId、positionAnchor、lookAt、transitionFromPrevious 与 boundaryId。",
    });
  } else {
    const spaces = new Set(topology.spaces.map((space) => space.spaceId));
    const boundaries = new Map(topology.boundaries.map((boundary) => [boundary.boundaryId, boundary]));
    const duplicateSpaces = topology.spaces.length !== spaces.size;
    const duplicateBoundaries = topology.boundaries.length !== boundaries.size;
    if (duplicateSpaces || duplicateBoundaries) {
      issues.push({
        severity: "error",
        code: "H3_CAMERA_TOPOLOGY_ID_DUPLICATE",
        message: "空间或边界 ID 重复，摄影机路径无法唯一解析。",
        suggestedFix: "让 spaceTopology 中每个 spaceId 和 boundaryId 唯一，并同步 cameraSegments 的引用。",
      });
    }
    for (const boundary of topology.boundaries) {
      if (!spaces.has(boundary.fromSpaceId) || !spaces.has(boundary.toSpaceId) || boundary.fromSpaceId === boundary.toSpaceId) {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_BOUNDARY_INVALID",
          message: `边界 ${boundary.boundaryId} 没有连接两个不同且已声明的空间。`,
          suggestedFix: "修正 spaceTopology 的边界两端；门、门槛或通道必须明确连接两个已声明空间。",
        });
      }
    }
    const orderedSegments = [...cameraSegments].sort((left, right) => left.startOffsetSec - right.startOffsetSec);
    orderedSegments.forEach((segment, index) => {
      if (!segment.spaceId || !segment.positionAnchor || !segment.lookAt || !segment.transitionFromPrevious) {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_SEGMENT_ANCHOR_MISSING",
          message: `第 ${index + 1} 段摄影机计划缺少空间、位置锚点、观察目标或过渡类型。`,
          suggestedFix: "逐段填写 spaceId、positionAnchor、lookAt、transitionFromPrevious；第一段为 initial，后续只允许连续移动、真实边界穿越或明确剪辑。",
        });
        return;
      }
      if (!spaces.has(segment.spaceId)) {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_SPACE_UNKNOWN",
          message: `第 ${index + 1} 段引用了未声明空间 ${segment.spaceId}。`,
          suggestedFix: "把该 spaceId 加入 spaceTopology.spaces，或改为已声明空间。",
        });
      }
      if (index === 0) {
        if (segment.transitionFromPrevious !== "initial" || segment.boundaryId) {
          issues.push({
            severity: "error",
            code: "H3_CAMERA_INITIAL_TRANSITION_INVALID",
            message: "第一段摄影机必须以 initial 开始，且不能伪造上一空间边界。",
            suggestedFix: "把第一段 transitionFromPrevious 设为 initial，并把 boundaryId 设为空。",
          });
        }
        return;
      }
      const previous = orderedSegments[index - 1];
      if (segment.transitionFromPrevious === "initial") {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_TRANSITION_RESET",
          message: `第 ${index + 1} 段在同一视频任务中重新声明 initial，等同于无解释重置机位。`,
          suggestedFix: "改为 continuous、boundary-crossing 或有叙事理由的 cut，并保留前一段结束位置。",
        });
      }
      if (segment.transitionFromPrevious !== "cut" && !segment.transitionPath) {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_TRANSITION_PATH_MISSING",
          message: `第 ${index + 1} 段没有说明摄影机如何从上一位置连续到达 ${segment.positionAnchor}。`,
          suggestedFix: "填写 transitionPath，说明可拍摄的连续路径、方向和所经边界；不能实际走到时必须保持原机位或拆镜。",
        });
      }
      if (plan.cameraContinuityMode === "single-take" && segment.transitionFromPrevious === "cut") {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_CUT_IN_SINGLE_TAKE",
          message: "镜头声明为 single-take，却在 cameraSegments 中插入了 cut。",
          suggestedFix: "删除切镜并给出连续可行路径，或在真实剧情转折处拆成两个 ShotSpec。",
        });
      }
      const changedSpace = Boolean(previous.spaceId && segment.spaceId !== previous.spaceId);
      if (!changedSpace && segment.transitionFromPrevious === "boundary-crossing") {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_FALSE_BOUNDARY_CROSSING",
          message: `第 ${index + 1} 段声明穿越边界，但摄影机仍在同一空间 ${segment.spaceId}。`,
          suggestedFix: "同一空间内移动使用 continuous；只有实际跨越门、门槛或通道时才使用 boundary-crossing。",
        });
      }
      if (changedSpace && segment.transitionFromPrevious !== "cut" && segment.transitionFromPrevious !== "boundary-crossing") {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_SPACE_TELEPORT",
          message: `摄影机从 ${previous.spaceId} 跳到 ${segment.spaceId}，但没有剪辑或真实边界穿越。`,
          suggestedFix: "保持摄影机在原空间，或声明并经过可穿越边界；若确实需要切换空间，应拆镜或明确 intentional-cuts。",
        });
      }
      if (segment.transitionFromPrevious === "boundary-crossing") {
        const boundary = segment.boundaryId ? boundaries.get(segment.boundaryId) : null;
        const connects = boundary && previous.spaceId && (
          (boundary.fromSpaceId === previous.spaceId && boundary.toSpaceId === segment.spaceId)
          || (boundary.toSpaceId === previous.spaceId && boundary.fromSpaceId === segment.spaceId)
        );
        if (!boundary || !connects || !boundary.traversalAllowed) {
          issues.push({
            severity: "error",
            code: "H3_CAMERA_BOUNDARY_TRAVERSAL_INVALID",
            message: `摄影机从 ${previous.spaceId} 到 ${segment.spaceId} 的边界穿越不存在、方向不匹配或不可通行。`,
            suggestedFix: "为这次空间变化引用真实且 traversalAllowed 的 boundaryId；无法穿越时不得让摄影机跨过去。",
          });
        }
      } else if (segment.boundaryId) {
        issues.push({
          severity: "error",
          code: "H3_CAMERA_UNUSED_BOUNDARY",
          message: `第 ${index + 1} 段没有执行 boundary-crossing，却引用了边界 ${segment.boundaryId}。`,
          suggestedFix: "非边界过渡将 boundaryId 设为空；真实穿越则把 transitionFromPrevious 改为 boundary-crossing。",
        });
      }
    });
  }

  const gateBudget = shot.durationSec <= 6 ? 4 : shot.durationSec <= 10 ? 5 : 6;
  if (timedStateGates.length > gateBudget) {
    issues.push({
      severity: "error",
      code: "H3_EXACT_TIMING_OVERLOAD",
      message: `单镜头包含 ${timedStateGates.length} 个精确事件门，超过 ${shot.durationSec} 秒镜头的稳定预算 ${gateBudget} 个。`,
      suggestedFix: "只保留不可提前发生的关键揭示时刻；次要动作改用先后顺序或宽时间段，必要时拆镜。",
    });
  }

  const layers = analysis.highRiskLayers;
  if (layers.length > 2) {
    issues.push({
      severity: "error",
      code: "H3_HIGH_RISK_LAYER_OVERLOAD",
      message: `单镜头同时承担 ${layers.join("、")} 共 ${layers.length} 层高风险生成任务。`,
      suggestedFix: "付费生产前每镜最多保留两层高风险任务；把镜面首次异常与开门后的群体揭示分到相邻镜头，并复制边界状态。",
    });
  }

  for (const gate of timedStateGates) {
    if (!screenDetailPattern.test(`${gate.beforeState}；${gate.afterState}`)) continue;
    const readable = displayRelations.some((relation) => relation.cameraReadable
      && relation.startOffsetSec <= gate.startsAtOffsetSec
      && relation.endOffsetSec >= gate.startsAtOffsetSec);
    if (!readable) {
      issues.push({
        severity: "error",
        code: "H3_INVISIBLE_SCREEN_DETAIL",
        message: `在 ${gate.startsAtOffsetSec} 秒安排了屏幕故障细节，但当时没有可读屏机位。`,
        suggestedFix: "删除不可见的压缩块/断字细节，只保留屏幕故障光映到人物脸侧和可听见的数字丢包声。",
      });
      break;
    }
  }

  const audioIssue = soundConflict(shot.sound ?? []);
  if (audioIssue) issues.push(audioIssue);
  return issues;
}

function uniqueTimes(prompt: string): number[] {
  const values = [...prompt.matchAll(/(?<![\w-])((?:\d{1,2}:)?\d+(?:\.\d+)?)\s*(?:秒)?(?=\s*(?:—|–|-|至|到|：|:|时))/gu)]
    .map((match) => parseClock(match[1]))
    .filter((value): value is number => value != null);
  return [...new Set(values.map((value) => Number(value.toFixed(3))))];
}

export function inspectH3PromptExecutability(
  prompt: string,
  durationSec: number,
  options: { cameraContinuityMode?: "single-take" | "intentional-cuts" } = {},
): H3ExecutabilityIssue[] {
  const issues: H3ExecutabilityIssue[] = [];
  const timeBudget = durationSec <= 6 ? 4 : durationSec <= 10 ? 5 : 6;
  const times = uniqueTimes(prompt);
  if (options.cameraContinuityMode === "single-take") {
    const singleTakeLock = /(?:连续(?:单镜头|长镜头|一镜到底)|一镜到底|不切镜|无切镜|禁止切镜)/u.test(prompt);
    const explicitCut = /(?:跳切|切镜|镜头切至|画面切到|剪辑切换|转场到)/u.test(prompt)
      && !/(?:不|无|禁止|避免)[^；。\n]{0,12}(?:跳切|切镜|剪辑切换|转场)/u.test(prompt);
    if (!singleTakeLock) {
      issues.push({
        severity: "error",
        code: "H3_PROMPT_SINGLE_TAKE_LOCK_MISSING",
        message: "导演脚本要求连续单镜头，但最终提示词没有明确写出无切镜约束。",
        suggestedFix: "在主体提示词开头明确写出‘全程连续单镜头、一镜到底、不切镜’，并保持摄影机沿声明路径移动。",
      });
    }
    if (explicitCut) {
      issues.push({
        severity: "error",
        code: "H3_PROMPT_CUT_CONTRADICTS_SINGLE_TAKE",
        message: "最终提示词同时要求连续单镜头和切镜/跳切，摄影语言自相矛盾。",
        suggestedFix: "删除所有切镜、跳切和转场指令；无法连续完成时回到导演脚本拆成相邻 ShotSpec。",
      });
    }
  }
  if (times.length > timeBudget) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_TIME_ANCHOR_OVERLOAD",
      message: `提示词包含 ${times.length} 个精确时间锚点，超过本镜头预算 ${timeBudget} 个。`,
      suggestedFix: "只保留镜头起点、关键揭示和终点；其他动作使用顺序描述或宽时间段。",
    });
  }

  const movements = prompt.match(new RegExp(movementPattern.source, "gu")) ?? [];
  if (movements.length > 3) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_CAMERA_OVERLOAD",
      message: `提示词出现 ${movements.length} 次独立运镜指令，超过稳定预算 3 次。`,
      suggestedFix: "保留建立运动、一次主要位移和一次结尾微调，删除厘米级来回修正。",
    });
  }
  const promptRiskLayers = [
    screenDetailPattern.test(prompt) ? "屏幕" : null,
    mirrorPattern.test(prompt) ? "镜面" : null,
    crowdPattern.test(prompt) ? "多复制体群体" : null,
    connectedSpacePattern.test(prompt) ? "反常直连空间" : null,
  ].filter((value): value is string => Boolean(value));
  if (promptRiskLayers.length > 2) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_HIGH_RISK_LAYER_OVERLOAD",
      message: `最终提示词仍同时承担 ${promptRiskLayers.join("、")} 共 ${promptRiskLayers.length} 层高风险任务。`,
      suggestedFix: "返回导演脚本按核心揭示拆镜；不得仅靠删短文字掩盖同一镜头仍承担的复杂任务。",
    });
  }
  if (screenDetailPattern.test(prompt) && unreadableScreenPattern.test(prompt)) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_INVISIBLE_DETAIL",
      message: "提示词要求生成屏幕冻结/压缩块等细节，同时又规定镜头无法读屏。",
      suggestedFix: "只写观众可见的屏幕故障光和可听见的丢包声。",
    });
  }
  if (/雾面[^；。\n]{0,50}(?:镜|反射)|(?:镜|反射)[^；。\n]{0,50}雾面/u.test(prompt) && /清楚|清晰|明确辨认/u.test(prompt)) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_REFLECTION_CLARITY_CONFLICT",
      message: "镜面被定义为雾面，同时又要求清楚辨认复杂镜像关系。",
      suggestedFix: "改为“磨损但仍能清楚成像的不锈钢镜面”，只保留必要镜像关系。",
    });
  }
  if (/(?:只|仅)[^；。\n]{0,15}(?:同步)?转头/u.test(prompt) && /(?:抬头|仰头)[^；。\n]{0,20}转头/u.test(prompt)) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_GROUP_ACTION_CONFLICT",
      message: "群体动作同时被定义为只转头和抬头加转头。",
      suggestedFix: "统一为单一动作：身体完全不动，仅头部同一瞬间同步转向。",
    });
  }
  if (/紧贴[^；。\n]{0,20}(?:背部|身后)/u.test(prompt) && /(?:贴近|靠近)[^；。\n]{0,20}(?:耳侧|耳边)/u.test(prompt)) {
    issues.push({
      severity: "error",
      code: "H3_PROMPT_MOVEMENT_ROUTE_AMBIGUOUS",
      message: "复制体先紧贴背后又继续贴近耳侧，缺少可见移动空间。",
      suggestedFix: "首次出现时站在反射后半步，之后再无声向前滑近耳侧。",
    });
  }
  const audioIssue = soundConflict(prompt.split(/[\r\n；。]+/u));
  if (audioIssue) issues.push(audioIssue);
  return issues;
}
