export const H3_PROMPT_TARGET_MAX_CHARACTERS = 3_200;
export const H3_PROMPT_PLATFORM_MAX_CHARACTERS = 7_000;

export function h3PromptTargetCharacters(durationSec: number, referenceCount: number): number {
  const safeDuration = Number.isFinite(durationSec) ? Math.max(1, durationSec) : 1;
  const extraReferences = Math.max(0, Math.min(8, referenceCount) - 4);
  const target = Math.round(1_500 + safeDuration * 80 + extraReferences * 60);
  return Math.min(H3_PROMPT_TARGET_MAX_CHARACTERS, Math.max(1_800, target));
}
