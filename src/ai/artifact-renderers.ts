import type {
  AssetBible,
  ContinuityReport,
  Screenplay,
  ShootingScript,
  Storyboard,
  StoryOutline,
} from "./text-provider";

export function renderOutline(outline: StoryOutline): string {
  const structures = outline.structure.map((part) => [
    `## ${part.sequence}. ${part.heading}（约 ${part.estimatedDurationSec} 秒）`,
    `**段落目的：** ${part.purpose}`,
    ...part.events.map((event) => `- ${event}`),
  ].join("\n\n")).join("\n\n");
  const changes = outline.proposedChanges.length
    ? outline.proposedChanges.map((item) => `- ${item.change}（原因：${item.reason}）`).join("\n")
    : "- 无；未擅自修改原故事。";
  return [
    `# ${outline.title}｜剧情大纲`,
    `**一句话故事：** ${outline.logline}`,
    `**目标时长：** ${outline.targetDurationSec} 秒`,
    `**主题：** ${outline.themes.join("、")}`,
    "# 结构",
    structures,
    "# 锁定事实",
    outline.lockedFacts.map((item) => `- ${item}`).join("\n") || "- 无",
    "# 可选修改建议",
    changes,
    "# 审批提示",
    outline.approvalNotes.map((item) => `- ${item}`).join("\n") || "- 请人工确认后再进入剧本。",
  ].join("\n\n");
}

export function renderScreenplay(screenplay: Screenplay): string {
  const scenes = screenplay.scenes.map((scene) => {
    const actions = scene.action.map((item) => item.trim()).filter(Boolean).join("\n\n");
    const dialogue = scene.dialogue.map((line) => `**${line.speaker}：** ${line.text}`).join("\n\n");
    return [`## ${scene.sequence}. ${scene.heading}`, actions, dialogue].filter(Boolean).join("\n\n");
  }).join("\n\n");
  return [
    `# ${screenplay.title}｜影视剧本 V${String(screenplay.version).padStart(3, "0")}`,
    `**依据的大纲：** ${screenplay.basedOnApprovedArtifact}`,
    `**原始内容保留：** ${screenplay.sourcePreserved ? "是" : "否"}`,
    scenes,
    "# 待确认问题",
    screenplay.unresolvedQuestions.map((item) => `- ${item}`).join("\n") || "- 无",
  ].join("\n\n");
}

export function renderAssetBible(assetBible: AssetBible): string {
  const assets = assetBible.assets.map((asset) => [
    `## ${asset.id} · ${asset.name}`,
    `**类型：** ${asset.type}`,
    `**身份：** ${asset.identity}`,
    `**外观：** ${asset.appearance}`,
    `**设计依据：** ${asset.designBasis}`,
    `**制作状态：** ${asset.productionReady ? "可制作" : "待补充"}`,
    `**视觉摘要：** ${asset.designSummary || "未提供"}`,
    `**识别特征：** ${asset.distinctiveFeatures.join("；") || "未提供"}`,
    `**禁止漂移：** ${asset.negativeConstraints.join("；") || "未提供"}`,
    `**连续性规则：** ${asset.continuityRules.join("；") || "无"}`,
    `**用途：** ${asset.usage.join("；") || "未指定"}`,
    `**剧本依据：** ${asset.sourceEvidence.join("；") || "未记录"}`,
    `**未知项：** ${asset.unknowns.join("；") || "无"}`,
  ].join("\n\n")).join("\n\n");
  const conflicts = assetBible.conflicts.map((issue) => `- [${issue.severity}] ${issue.code}：${issue.message}`).join("\n") || "- 无";
  return ["# 逻辑资产定义", assets, "# 冲突与问题", conflicts].join("\n\n");
}

export function renderShootingScript(shootingScript: ShootingScript): string {
  const shots = shootingScript.shots.map((shot) => [
    `## ${shot.id} · ${shot.startTimeSec.toFixed(2)}–${shot.endTimeSec.toFixed(2)} 秒`,
    `**目的：** ${shot.purpose}`,
    `**景别 / 摄影：** ${shot.shotSize}；${shot.camera.position}；${shot.camera.movement}${shot.camera.lens ? `；${shot.camera.lens}` : ""}${shot.camera.composition ? `；${shot.camera.composition}` : ""}`,
    `**资产引用：** ${[...shot.characterIds, shot.sceneId, ...shot.propIds, ...shot.styleIds].join("、")}`,
    `**动作：** ${shot.action}`,
    `**对白：** ${shot.dialogue.map((line) => `${line.speakerId}：${line.text}`).join("；") || "无"}`,
    `**声音：** ${shot.sound.join("；") || "无"}`,
    `**起始状态：** ${shot.startState}`,
    `**结束状态：** ${shot.endState}`,
  ].join("\n\n")).join("\n\n");
  const notes = shootingScript.validationNotes.map((issue) => `- [${issue.severity}] ${issue.code}：${issue.message}`).join("\n") || "- 无";
  return [`# 时间码导演脚本 · ${shootingScript.targetDurationSec} 秒`, shots, "# 校验说明", notes].join("\n\n");
}

export function renderStoryboard(storyboard: Storyboard): string {
  const shots = storyboard.shots.map((shot) => [
    `## ${shot.shotId}`,
    `**起始帧：** ${shot.startFrame}`,
    `**结束帧：** ${shot.endFrame}`,
    `**构图：** ${shot.composition}`,
    `**运动计划：** ${shot.motionPlan}`,
    `**资产引用：** ${shot.requiredAssetIds.join("、") || "无"}`,
    `**连续性风险：** ${shot.continuityRisks.join("；") || "无"}`,
  ].join("\n\n")).join("\n\n");
  return ["# 分镜与关键帧设计", shots, "# 全局连续性说明", storyboard.globalContinuityNotes.map((item) => `- ${item}`).join("\n") || "- 无"].join("\n\n");
}

export function renderContinuityReport(report: ContinuityReport): string {
  const issues = report.issues.map((issue) => [
    `## [${issue.severity}] ${issue.code}`,
    issue.message,
    `**影响：** ${issue.affectedIds.join("、") || "未指定"}`,
    `**建议修复：** ${issue.suggestedFix}`,
    `**需要重新审批：** ${issue.requiresReapproval ? "是" : "否"}`,
  ].join("\n\n")).join("\n\n") || "无问题。";
  return [
    "# 连续性检查报告",
    `**结论：** ${report.passed ? "通过" : "存在问题"}`,
    `**已检查镜头：** ${report.checkedShotIds.join("、")}`,
    issues,
    "# 尚无法验证",
    report.uncheckedClaims.map((item) => `- ${item}`).join("\n") || "- 无",
  ].join("\n\n");
}
