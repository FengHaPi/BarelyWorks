# Output contract

Return JSON matching `continuityReportSchema` in `src/shared/skill-schemas.ts`.

`passed` is true only when no error-severity issue remains. Every issue has stable severity/code/message, affected IDs, a suggested fix, and a reapproval flag. Unobservable media claims belong in `uncheckedClaims`.

Use stable physical-rule code families where applicable: `PHYSICAL_CAMERA_*`, `PHYSICAL_ORIENTATION_*`, `PHYSICAL_DISPLAY_*`, `PHYSICAL_REFLECTION_*`, and `PHYSICAL_TIMED_GATE_*`. Any impossible geometry, contradictory direction, merged reflection role, or unguarded early state change is error severity and requires reapproval of the affected upstream artifact.
