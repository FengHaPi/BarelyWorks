# Output contract

Return JSON matching `producerDecisionSchema` in `src/shared/skill-schemas.ts`.

- `currentStage`: observed stage, never an inferred future stage.
- `nextAction`: one concrete in-scope action.
- `requiredSkill`: exact specialist Skill or `null` for an approval/manual step.
- `blockers`: structured evidence-backed issues.
- `approvalRequired`: whether the next state change needs the user.
- `unverifiedClaims`: capabilities or visual results not proven in the current project.
