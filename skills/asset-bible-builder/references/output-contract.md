# Output contract

Return JSON matching `assetBibleSchema` in `src/shared/skill-schemas.ts`.

Logical assets describe identity and continuity; they do not impersonate file registry records. Every detail should be grounded in `sourceEvidence` or placed in `unknowns`. Conflicts use structured issue objects.

Each asset must also return `designBasis`, `productionReady`, `designSummary`, `distinctiveFeatures`, and `negativeConstraints`. `source-grounded` means supported by approved input, `creative-proposal` means a reviewable original design choice, and `reference-guided` means an supplied visual reference controls the design. Never mark a visual asset ready when its basic drawable appearance is still deferred. Under `original-proposal`, production-critical visual gaps are filled as proposals instead of being placed in `unknowns`; under `reference-first`, unresolved gaps remain explicit and `productionReady` is false.

Keep fields concise and asset-specific. Avoid repeating identical continuity and unknown-detail paragraphs across sibling characters; project-wide rules belong in the relevant style or scene asset. Concision must not remove screenplay-supported facts.
