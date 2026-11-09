# Audit records and tamper detection

What exists (verified by `tests/integration/auth-orgs.test.ts`):
- `AuditEvent` rows are insert-only: database triggers reject `UPDATE` and `DELETE`, so application bugs and SQL injection through the app cannot rewrite history.
- Submitted `QuoteVersion` rows are immutable by trigger; an edit must create a new version.
- Payloads exclude secrets, raw tokens and passwords.

What it does NOT prove:
- A database superuser or anyone with storage/backup access can disable triggers or alter files. These records are **not immutable** and **not blockchain-backed**; do not describe them that way.
- There is no hash chain or external anchoring yet. Until one exists, tamper *detection* is limited to access controls and backups.

Who can alter storage: whoever holds the database superuser role and the host/backup volumes. Owners and operational roles are **Not specified in this brief**; document them before any pilot with real orders.
