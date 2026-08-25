# Output contract

Return JSON matching `projectIntakeOutputSchema` in `src/shared/skill-schemas.ts`.

The constraints object must contain every required project setting. Missing optional facts use `null`; unresolved requirements belong in `missingInformation`. Warnings need a severity, stable code, human-readable message, and affected IDs when applicable.
