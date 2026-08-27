# Output contract

Return JSON matching `storyboardSchema` in `src/shared/skill-schemas.ts`.

Return `schemaVersion: storyboard-v2`. Every storyboard item includes `physicalVerification`. Use `not-applicable` only when the corresponding ShotSpec applicability declaration is false; otherwise return `pass` or `fail`. `cameraBlocking` always returns `pass` or `fail`. Notes identify the concrete visible geometry used for confirmation or the exact conflict.

There is one storyboard item per ShotSpec. Frame descriptions must be observable, asset references use IDs, and risks stay separate from approved content. Copy `characterIds` and `sceneId` exactly from the matching approved ShotSpec. `requiredAssetIds` must include every ID from that ShotSpec's `characterIds`, `sceneId`, `propIds`, and `styleIds`; additional IDs are allowed only when they exist in the approved asset bible. `approved` defaults to false until recorded user approval exists.
