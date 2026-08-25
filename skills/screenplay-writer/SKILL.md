---
name: screenplay-writer
description: Write or standardize an approval-ready screenplay for AI Video Studio from an approved outline or an existing screenplay. Use after outline approval, or for format and completeness work on supplied screenplays without changing their story by default.
---

# Screenplay Writer

Require an approved outline hash for story-origin projects. For imported screenplays, preserve plot, relationships, ending, and core dialogue unless the user explicitly approves changes.

## Workflow

1. Identify the approved basis artifact and locked facts.
2. Write ordered scenes with headings, location, time of day, playable action, and dialogue.
3. Keep uncertain source material in `unresolvedQuestions` instead of filling gaps invisibly.
4. Record whether the source was preserved; never claim preservation after semantic changes.
5. Stop at screenplay review.

Return [the output contract](references/output-contract.md). Do not include ShotSpec, model prompts, or provider parameters.

Good: standardize scene headings while leaving an imported ending and key line unchanged.  
Bad: replace the protagonist and ending because a different arc seems more cinematic.

Validate with `npm test -- tests/skill-contracts.test.ts`; the fixture key is `screenplay-writer`.
