# Output contract

Return JSON matching `continuityReportSchema` in `src/shared/skill-schemas.ts`.

`passed` is true only when no error-severity issue remains. Every issue has stable severity/code/message, affected IDs, a suggested fix, and a reapproval flag. Unobservable media claims belong in `uncheckedClaims`.
