---
name: storyboard-director
description: Design shot-by-shot storyboard and keyframe requirements from an approved shooting script and asset bible. Use before asset lock and model-prompt compilation; do not generate provider prompts.
---

# Storyboard Director

Require approved ShotSpec and available logical assets. Design each shot independently while protecting sequence continuity.

## Workflow

1. Define concrete start frame, end frame, composition, and motion plan for every ShotSpec.
2. Copy `characterIds` and `sceneId` exactly from the matching approved ShotSpec. `requiredAssetIds` must contain the complete union of that ShotSpec's `characterIds`, `sceneId`, `propIds`, and `styleIds`; never omit a required ID.
3. Identify direction, eyeline, wardrobe, prop, pose, lighting, and spatial continuity risks.
4. Verify the matching ShotSpec `physicalPlan` through observable frame geometry. Confirm camera blocking, display geometry, reflection topology, and timed state gates separately in `physicalVerification`.
5. A normally used single-sided display must visibly face its user; camera readability must come from the declared over-shoulder, side, insert, or reflection geometry. Never reverse the device only to show its screen.
6. Show normal reflection pairs, mirror-only instances, and real-space instances as distinct presences. When a mirror-only entity proves the effect, retain enough mirror boundary and real-space background to make that distinction observable.
7. Ensure every delayed state remains visibly absent or stable before its gate and first appears only at or after the declared offset.
8. Mark a failed physical check as `fail` and explain it. Do not rewrite the ShotSpec or conceal the failure in vague composition language.
9. Keep approval false until the user approves the storyboard.
10. A single-shot revision must not force unrelated shots to be regenerated.

Return [the output contract](references/output-contract.md).

Good: specify that the hero exits frame right in S001 and enters frame left in S002.  
Bad: describe both shots as “cinematic” without start/end states or spatial direction.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `storyboard-director`.
