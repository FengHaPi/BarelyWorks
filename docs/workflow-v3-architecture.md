# Workflow V3 Architecture

Workflow V3 is an isolated, auditable control plane for the text-to-generation-package portion of AI Video Studio. It combines probabilistic content generation with deterministic records for lineage, verification, human authority, and production readiness.

## Why V3 exists

The existing application grew around a global stage projection, mutable "current" selections, artifact versions, approvals, operations, and later production records. Those concerns are individually useful, but their overlap makes it difficult to answer a simple production question: exactly which immutable inputs, checks, and human decisions authorize the current downstream output?

V3 answers that question with a deliberately separate chain. It does not open or migrate the legacy SQLite database, read legacy stage state, or call legacy repair/operation services. This is an additive experiment, not a replacement migration.

## Core principles

- **Immutable Artifacts.** A committed Artifact record and payload are never edited in place.
- **Explicit lineage.** Every downstream Artifact stores ordered input Artifact IDs and their exact content hashes.
- **Stable shot identity.** `shotUid` is immutable across downstream projections; display labels are not identity.
- **Deterministic verification where possible.** Verification creates an immutable receipt bound to one Artifact hash.
- **Separated human authority.** Model generation, Verification, human Approval, and Adoption are different actions and records.
- **Immutable Adoption history.** Every Adoption appends a receipt. A replaceable current projection points to one receipt but does not erase history.
- **Fail closed.** Missing, unknown, stale, mismatched, or failed evidence blocks the Production Gate.
- **No downstream mutation of upstream.** A later stage can reference an upstream Artifact but cannot rewrite it.
- **No automatic repair loop.** Failure stops the main chain. The repair contract describes a possible bounded candidate operation but is not invoked automatically by V3.

## Artifact → Verification → Approval → Adoption

```text
Artifact
  └─ exact payload hash + exact input Artifact refs
      ↓
Verification receipt
  └─ artifactId + artifactHash + deterministic checks
      ↓
Human Approval receipt
  └─ artifactId + artifactHash + verificationReceiptId
      ↓
Immutable Adoption receipt
  └─ artifactId + artifactHash + approvalReceiptId
      ↓
Current Adoption projection
  └─ points to the immutable adoptionId
```

Generation does not update current state. A passed Verification also does not update current state. A human first records Approval and then explicitly adopts that exact Artifact. Replacing a current projection appends a new Adoption receipt; prior receipts remain available for audit.

## `shotUid` and `displayId`

`shotUid` is the stable machine identity created when a Shooting Script candidate enters V3. Storyboard frames and Generation Package tasks must carry the same `shotUid` values in the same one-to-one topology.

`displayId` is a human-readable label such as `S001`. It may be useful in scripts and interfaces, but it is not the durable join key and cannot silently substitute for `shotUid`.

## Production Gate

The Production Gate reads current Adoption projections only. For each required kind it resolves the exact immutable Adoption receipt, Artifact, human Approval, and passed Verification. It then checks payload integrity and the required direct lineage:

```text
Source → Outline
Source + Outline → Screenplay
Screenplay → Asset Bible
Screenplay + Asset Bible → Shooting Script
Shooting Script + Asset Bible → Storyboard
```

The gate returns blockers rather than guessing. Only a passed gate allows the deterministic compiler to create a Generation Package from the adopted Asset Bible, Shooting Script, and Storyboard.

## Failure semantics

- A generation exception creates no adopted state and no downstream package.
- A failed Verification receipt prevents Approval/Adoption and stops the chain.
- A rejected or hash-mismatched Approval cannot be adopted.
- A stale or tampered Adoption projection fails the gate.
- Missing input records, reordered lineage, changed content hashes, or unknown evidence fail closed.
- Gate and failure checks do not call a model, revision service, repair service, or regeneration path.
- Failure/chaos tests snapshot the legacy SQLite path and local Live-run directory before and after each case to prove zero workflow side effects.

## Current boundaries

V3 currently covers Source through Storyboard generation, immutable evidence, human selection, the Production Gate, and deterministic Generation Package creation. It does not yet integrate H3 compilation, video-provider execution, per-shot media QA, editing/delivery, a production UI, or migration of existing legacy projects. It also does not claim to solve every semantic contradiction in natural-language content; deterministic checks cover only facts that can be expressed and validated reliably.
