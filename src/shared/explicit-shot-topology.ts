export interface ExplicitShotTopologyShot {
  id: string;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
}

export interface ExplicitShotTopology {
  targetDurationSec: number;
  shots: ExplicitShotTopologyShot[];
  sourceStatements: string[];
}

export interface ExplicitShotTopologyValidation {
  valid: boolean;
  errors: string[];
}

export type ExplicitShotTopologyExtraction =
  | { status: "absent"; topology: null; sourceStatements: []; errors: [] }
  | { status: "valid"; topology: ExplicitShotTopology; sourceStatements: string[]; errors: [] }
  | { status: "invalid"; topology: null; sourceStatements: string[]; errors: string[] };

const exactConstraintPattern = /(?:必须|恰好|\bexactly\b|\bmust\b)/iu;
const shotNounPattern = /(?:镜头|\bshots?\b)/iu;
const shotIdPattern = /^S\d{3}$/u;
const shotRangePattern = /\b(S\d{3})\b\s*(?:(?:[:：=]|为|从|from)\s*)?(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)?\s*(?:[-–—~～]|至|到|\bto\b)\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)/giu;
const shotCountPattern = /(\d+|[一二三四五六七八九十两]+)\s*(?:个)?\s*(?:生产\s*)?(?:镜头|shots?)/iu;
const multipliedDurationPattern = /(\d+|[一二三四五六七八九十两]+)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)\s*(?:的?\s*)?(?:镜头|shots?)?/iu;
const shotThenDurationPattern = /(\d+|[一二三四五六七八九十两]+)\s*(?:个)?\s*(?:生产\s*)?(?:镜头|shots?)\s*[,，:：;；]?\s*(?:[×xX*]\s*|(?:(?:每(?:个镜头|镜|个)?|each)\s*)?(?:时长\s*)?(?:为|是|=|of)?\s*)(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)(?:\s*each)?/iu;
const durationThenShotPattern = /(\d+|[一二三四五六七八九十两]+)\s*(?:个)?\s*(?:连续\s*)?(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)\s*(?:的?\s*)?(?:生产\s*)?(?:镜头|shots?)/iu;
const maximumExtractedShotCount = 10_000;

function splitSourceStatements(sourceText: string): string[] {
  return sourceText
    .split(/(?:[。！？!?]+|\r?\n+|(?<!\d)\.(?:\s+|$))/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function numberEquals(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-9;
}

function parseShotCount(value: string): number | null {
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  if (!value.includes("十")) return digits[value] ?? null;
  const [tensText, onesText] = value.split("十");
  const tens = tensText ? digits[tensText] : 1;
  const ones = onesText ? digits[onesText] : 0;
  return tens && ones !== undefined ? tens * 10 + ones : null;
}

function sameShots(left: ExplicitShotTopologyShot[], right: ExplicitShotTopologyShot[]): boolean {
  return left.length === right.length && left.every((shot, index) => {
    const other = right[index];
    return shot.id === other.id
      && numberEquals(shot.startTimeSec, other.startTimeSec)
      && numberEquals(shot.endTimeSec, other.endTimeSec)
      && numberEquals(shot.durationSec, other.durationSec);
  });
}

export function validateExplicitShotTopology(topology: ExplicitShotTopology): ExplicitShotTopologyValidation {
  const errors: string[] = [];
  if (!Number.isFinite(topology.targetDurationSec) || topology.targetDurationSec <= 0) {
    errors.push("显式镜头拓扑的目标时长必须是正数。");
  }
  if (topology.shots.length === 0) {
    errors.push("显式镜头拓扑没有提供任何生产镜头。");
    return { valid: false, errors };
  }

  const ids = new Set<string>();
  for (const shot of topology.shots) {
    if (!shotIdPattern.test(shot.id)) {
      errors.push(`显式镜头 ID ${shot.id} 不是 Sxxx 格式。`);
    }
    if (ids.has(shot.id)) {
      errors.push(`显式镜头 ID ${shot.id} 重复。`);
    }
    ids.add(shot.id);
    if (![shot.startTimeSec, shot.endTimeSec, shot.durationSec].every(Number.isFinite)) {
      errors.push(`${shot.id} 的显式起止或时长不是有限数字。`);
      continue;
    }
    if (shot.startTimeSec < 0 || shot.endTimeSec <= shot.startTimeSec) {
      errors.push(`${shot.id} 的显式时间范围 ${shot.startTimeSec}–${shot.endTimeSec} 秒无效。`);
    }
    if (!numberEquals(shot.durationSec, shot.endTimeSec - shot.startTimeSec)) {
      errors.push(`${shot.id} 的显式时长 ${shot.durationSec} 秒与起止时间不一致。`);
    }
  }

  const first = topology.shots[0];
  if (first && !numberEquals(first.startTimeSec, 0)) {
    errors.push(`显式镜头拓扑必须从 0 秒开始，当前从 ${first.startTimeSec} 秒开始。`);
  }
  for (let index = 1; index < topology.shots.length; index += 1) {
    const previous = topology.shots[index - 1];
    const current = topology.shots[index];
    if (!numberEquals(previous.endTimeSec, current.startTimeSec)) {
      errors.push(`${previous.id} 与 ${current.id} 的显式时间范围不连续（${previous.endTimeSec} → ${current.startTimeSec} 秒）。`);
    }
  }
  const last = topology.shots.at(-1);
  if (last && !numberEquals(last.endTimeSec, topology.targetDurationSec)) {
    errors.push(`显式镜头拓扑结束于 ${last.endTimeSec} 秒，未覆盖项目目标 ${topology.targetDurationSec} 秒。`);
  }
  return { valid: errors.length === 0, errors };
}

function uniformTopology(count: number, durationSec: number): ExplicitShotTopologyShot[] {
  return Array.from({ length: count }, (_, index) => {
    const startTimeSec = index * durationSec;
    return {
      id: `S${String(index + 1).padStart(3, "0")}`,
      startTimeSec,
      endTimeSec: startTimeSec + durationSec,
      durationSec,
    };
  });
}

/**
 * Extracts only source-authored, exact production-shot topology. Scene labels or
 * ordinary screenplay timing never become a production-shot constraint unless
 * the same statement also contains an exact/must qualifier and a shot noun.
 */
export function extractExplicitShotTopology(
  sourceText: string,
  targetDurationSec: number,
): ExplicitShotTopologyExtraction {
  const sourceStatements: string[] = [];
  const rangeShots: ExplicitShotTopologyShot[] = [];
  const declaredCounts: number[] = [];
  const uniformCandidates: ExplicitShotTopologyShot[][] = [];
  const extractionErrors: string[] = [];

  for (const statement of splitSourceStatements(sourceText)) {
    if (!exactConstraintPattern.test(statement) || !shotNounPattern.test(statement)) continue;

    const ranges = [...statement.matchAll(shotRangePattern)].map((match) => {
      const startTimeSec = Number(match[2]);
      const endTimeSec = Number(match[3]);
      return {
        id: match[1].toUpperCase(),
        startTimeSec,
        endTimeSec,
        durationSec: endTimeSec - startTimeSec,
      };
    });
    const multiplied = multipliedDurationPattern.exec(statement)
      ?? shotThenDurationPattern.exec(statement)
      ?? durationThenShotPattern.exec(statement);
    if (ranges.length === 0 && !multiplied) continue;

    sourceStatements.push(statement);
    const countMatch = shotCountPattern.exec(statement);
    const declaredCount = countMatch ? parseShotCount(countMatch[1]) : null;
    if (declaredCount !== null) declaredCounts.push(declaredCount);
    rangeShots.push(...ranges);
    if (multiplied) {
      const count = parseShotCount(multiplied[1]);
      const durationSec = Number(multiplied[2]);
      if (count === null || count <= 0 || count > maximumExtractedShotCount || !Number.isFinite(durationSec) || durationSec <= 0) {
        extractionErrors.push(`显式 N×时长约束“${multiplied[0]}”无效或超出安全上限。`);
      } else {
        uniformCandidates.push(uniformTopology(count, durationSec));
      }
    }
  }

  if (sourceStatements.length === 0) {
    return { status: "absent", topology: null, sourceStatements: [], errors: [] };
  }

  const errors: string[] = [...extractionErrors];
  const distinctDeclaredCounts = [...new Set(declaredCounts)];
  if (distinctDeclaredCounts.length > 1) {
    errors.push(`显式语句给出了互相矛盾的镜头数量：${distinctDeclaredCounts.join("、")}。`);
  }

  const byId = new Map<string, ExplicitShotTopologyShot>();
  for (const shot of rangeShots) {
    const existing = byId.get(shot.id);
    if (existing && !sameShots([existing], [shot])) {
      errors.push(`${shot.id} 在显式语句中具有互相矛盾的起止时间。`);
      continue;
    }
    byId.set(shot.id, shot);
  }
  const rangedTopology = [...byId.values()].sort((left, right) => left.startTimeSec - right.startTimeSec || left.id.localeCompare(right.id));
  if (rangeShots.length > byId.size) {
    const repeatedIds = rangeShots
      .map((shot) => shot.id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    if (repeatedIds.length > 0 && errors.length === 0) {
      errors.push(`显式语句重复定义了镜头 ID：${[...new Set(repeatedIds)].join("、")}。`);
    }
  }

  const firstUniform = uniformCandidates[0];
  for (const candidate of uniformCandidates.slice(1)) {
    if (!sameShots(firstUniform, candidate)) {
      errors.push("显式语句给出了互相矛盾的 N×时长镜头拓扑。");
      break;
    }
  }
  if (rangedTopology.length > 0 && firstUniform && !sameShots(rangedTopology, firstUniform)) {
    errors.push("显式 Sxxx 起止时间与显式 N×时长镜头拓扑互相矛盾。");
  }

  const shots = rangedTopology.length > 0 ? rangedTopology : firstUniform;
  if (!shots) {
    errors.push("显式镜头约束未能形成可验证的生产镜头拓扑。");
  } else if (distinctDeclaredCounts.length === 1 && distinctDeclaredCounts[0] !== shots.length) {
    errors.push(`显式声明要求 ${distinctDeclaredCounts[0]} 个镜头，但只定义了 ${shots.length} 个。`);
  }

  if (shots) {
    const validation = validateExplicitShotTopology({ targetDurationSec, shots, sourceStatements });
    errors.push(...validation.errors);
  }
  if (errors.length > 0 || !shots) {
    return { status: "invalid", topology: null, sourceStatements, errors: [...new Set(errors)] };
  }
  return {
    status: "valid",
    topology: { targetDurationSec, shots, sourceStatements },
    sourceStatements,
    errors: [],
  };
}
