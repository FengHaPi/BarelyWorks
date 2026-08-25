---
name: storyboard-director
description: Design shot-by-shot storyboard and keyframe requirements from an approved shooting script and asset bible. Use before asset lock and model-prompt compilation; do not generate provider prompts.
---

# Storyboard Director

Require approved ShotSpec and available logical assets. Design each shot independently while protecting sequence continuity.

## Workflow

1. Define concrete start frame, end frame, composition, and motion plan for every ShotSpec.
2. List character, scene, and required asset IDs.
3. Identify direction, eyeline, wardrobe, prop, pose, lighting, and spatial continuity risks.
4. Keep approval false until the user approves the storyboard.
5. A single-shot revision must not force unrelated shots to be regenerated.

Return [the output contract](references/output-contract.md).

Good: specify that the hero exits frame right in S001 and enters frame left in S002.  
Bad: describe both shots as “cinematic” without start/end states or spatial direction.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `storyboard-director`.
