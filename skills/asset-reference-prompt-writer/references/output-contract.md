# Output contract

Return JSON matching `assetReferencePromptOutputSchema` in `src/shared/skill-schemas.ts`.

- `schemaVersion` is exactly `asset-reference-prompt-v1`.
- `assetId` and `role` exactly match the supplied request.
- `promptZh` and `promptEn` are complete provider-neutral image prompts, not summaries or Markdown.
- `negativePrompt` contains only prohibited visual outcomes and identity drift risks.
- `compositionNotes` records role-specific framing and visibility requirements.
- `continuityLocks` contains the stable identity, palette, geometry, material, or landmark facts that later variants must preserve.

Do not return image bytes, URLs, file paths, hashes, API task IDs, approval claims, or cost claims.
