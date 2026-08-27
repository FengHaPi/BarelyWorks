import type { MediaMetadata } from "../shared/quality-schemas";
import type { Project, ShotSpec } from "../shared/schemas";

function ratio(value: string): number | null {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const result = Number(match[1]) / Number(match[2]);
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function importedMediaIssues(project: Project, shot: ShotSpec, media: MediaMetadata): string[] {
  const issues: string[] = [];
  const durationTolerance = Math.max(0.25, shot.durationSec * 0.03);
  if (Math.abs(media.durationSec - shot.durationSec) > durationTolerance) {
    issues.push(`实测时长 ${media.durationSec.toFixed(3)} 秒与镜头目标 ${shot.durationSec.toFixed(3)} 秒不一致`);
  }
  const expectedRatio = ratio(project.aspectRatio);
  const actualRatio = media.width / media.height;
  if (expectedRatio && Math.abs(actualRatio - expectedRatio) / expectedRatio > 0.02) {
    issues.push(`实测画面 ${media.width}x${media.height} 与项目画幅 ${project.aspectRatio} 不一致`);
  }
  if (Math.min(media.width, media.height) < 480) {
    issues.push(`实测画面 ${media.width}x${media.height} 低于最低 480p 生成规格`);
  }
  return issues;
}
