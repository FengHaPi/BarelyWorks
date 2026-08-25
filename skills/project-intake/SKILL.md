---
name: project-intake
description: Classify incoming stories, screenplays, shooting scripts, or storyboard packages for AI Video Studio and extract production constraints without rewriting source material. Use at project creation or when importing an existing project entry artifact.
---

# Project Intake

Treat the imported source as immutable evidence. Identify the furthest stage genuinely present, not the stage the user hopes it represents.

## Workflow

1. Read the source plus requested duration, aspect ratio, resolution, video type, style, platform, audience, references, and permission to suggest story changes.
2. Classify as `story`, `screenplay`, `shooting-script`, or `storyboard` using observable structure.
3. Preserve named characters, relationships, ending, key dialogue, and explicit camera/time constraints as facts.
4. List missing or conflicting information. Use `unknown` rather than guessing.
5. Return the detected entry stage and constraints using [the output contract](references/output-contract.md).

Never rewrite a supplied screenplay, invent model capabilities, or label a loose idea as a finished shooting script. If confidence is low, keep the safest earlier stage and explain why.

Good: classify a scene-headed script with dialogue as `screenplay` and preserve its ending.  
Bad: turn a paragraph synopsis into `storyboard` because it mentions three shots.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `project-intake`.
