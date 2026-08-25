# Output contract

Return one review object with:

- `jobId`, `shotId`, and generated `version` copied from the imported result.
- `dimensions`: exactly one entry for each required dimension.
- Each dimension has `dimension`, `status`, `note`, and `evidence`.
- `decision`: `accepted`, `conditional-pass`, `retry-same-model`, `revise-prompt-retry`, `switch-model`, or `manual-fix`.
- `summary`: concise factual rationale.
- `conditions`: unresolved conditions for a conditional pass; otherwise an empty array.
- `retryInstructions`: concrete changes for retry decisions; otherwise an empty array.
- `unverifiedClaims`: anything that could not be checked.

Required dimensions in order:

1. `identity`
2. `costume-props`
3. `scene`
4. `action`
5. `camera`
6. `composition-direction`
7. `start-end-state`
8. `picture-quality`
9. `sound-quality`

An accepted review cannot contain `fail` or `not-reviewed`. A conditional pass cannot contain `fail` and must list at least one condition. Retry and switch decisions must include at least one failed dimension and at least one retry instruction.
