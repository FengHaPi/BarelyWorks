# Output contract

Return JSON matching `storyboardSchema` in `src/shared/skill-schemas.ts`.

There is one storyboard item per ShotSpec. Frame descriptions must be observable, asset references use IDs, and risks stay separate from approved content. `approved` defaults to false until recorded user approval exists.
