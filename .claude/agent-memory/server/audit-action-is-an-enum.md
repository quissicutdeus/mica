# A new audit action is a schema change

`mica_audit_logs.action` is a MariaDB `ENUM` in the hand-written
`scripts/framework-schema.sql`, mirrored by the `AuditAction` union in
`server/lib/AuditLogger.ts`. A brief that says "audit-log X through AuditLogger"
for something that is not archive, delete, moderate or view needs three things:

- a widened enum, which means a versioned migration
- a new union member
- a CHANGELOG "Action required" entry

The `Database` stub accepts any string, so no unit suite notices an out-of-enum
value. Only `test:schema` against real MariaDB would, and in production the
insert fails into `AuditLogger`'s catch, which logs and returns `false`.

The ledger is the moderation ledger. `forwardAudit` mirrors it to Discord,
filtered by `isStaffRelevant`. A non-moderation action belongs there only by the
lead's decision.

Found on MICA-307 (2026-10-05): the brief asked to audit-log a group-call
answer. It was stopped and reported rather than migrated, and the lead dropped
it: routine call traffic does not belong in the moderation ledger, and the
answerer's own call-log row already records who took the call.
