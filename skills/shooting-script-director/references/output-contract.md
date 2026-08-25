# Output contract

Return JSON matching `shootingScriptSchema` in `src/shared/skill-schemas.ts`.

Shot IDs use `S001` form. Timecodes must be continuous, every duration must equal end minus start, and the final end must equal `targetDurationSec`. Use only asset IDs, not ambiguous filenames.

When `generationConstraints` are supplied, each shot duration must be within `durationMinSec` and `durationMaxSec`, the shot count must not exceed `maxShotsForTargetDuration`, and one shot maps to one generation task. Combine related beats through blocking and camera movement inside a valid-duration shot instead of returning fragments that the selected adapter cannot submit.
