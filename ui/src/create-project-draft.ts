import type { CreateProjectInput, SourceType } from "./types";

export const createProjectDraftStorageKey = "ai-video-studio:create-project-draft:v1";

const sourceTypes = new Set<SourceType>(["story", "screenplay", "shooting-script", "storyboard"]);
const aspectRatios = new Set(["16:9", "9:16", "1:1"]);

interface StoredCreateProjectDraft {
  version: 1;
  form: CreateProjectInput;
  savedAt: string;
}

export function parseCreateProjectDraft(raw: string | null): CreateProjectInput | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredCreateProjectDraft>;
    const form = stored.form as Partial<CreateProjectInput> | undefined;
    if (stored.version !== 1 || !form) return null;
    if (typeof form.title !== "string" || typeof form.sourceText !== "string") return null;
    if (typeof form.sourceType !== "string" || !sourceTypes.has(form.sourceType as SourceType)) return null;
    if (!Number.isFinite(form.targetDurationSec) || Number(form.targetDurationSec) < 5 || Number(form.targetDurationSec) > 21_600) return null;
    if (typeof form.aspectRatio !== "string" || !aspectRatios.has(form.aspectRatio)) return null;
    if (typeof form.resolution !== "string" || !form.resolution.trim()) return null;
    if (typeof form.videoType !== "string" || typeof form.visualStyle !== "string") return null;
    if (typeof form.releasePlatform !== "string" || typeof form.targetAudience !== "string") return null;
    if (typeof form.allowStorySuggestions !== "boolean") return null;
    return {
      title: form.title,
      sourceType: form.sourceType as SourceType,
      sourceText: form.sourceText,
      targetDurationSec: Number(form.targetDurationSec),
      aspectRatio: form.aspectRatio,
      resolution: form.resolution,
      videoType: form.videoType,
      visualStyle: form.visualStyle,
      releasePlatform: form.releasePlatform,
      targetAudience: form.targetAudience,
      allowStorySuggestions: form.allowStorySuggestions,
    };
  } catch {
    return null;
  }
}

export function serializeCreateProjectDraft(form: CreateProjectInput): string {
  return JSON.stringify({ version: 1, form, savedAt: new Date().toISOString() } satisfies StoredCreateProjectDraft);
}

export function hasMeaningfulCreateProjectDraft(form: CreateProjectInput, defaults: CreateProjectInput): boolean {
  return (Object.keys(defaults) as Array<keyof CreateProjectInput>).some((key) => form[key] !== defaults[key]);
}
