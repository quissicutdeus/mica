import { Database } from './Database';

/**
 * The moderation ledger's table.
 *
 * Named here rather than only inside the INSERT because it is **the one `citizenid`-bearing
 * gPhone table with no `defineService` behind it** — it is emitted verbatim from the
 * hand-written `scripts/framework-schema.sql`, so nothing derives it from a declaration and
 * `declaredServices` yields 21 of the 22 tables that carry the owner cascade. The orphan
 * sweep imports this constant so the twenty-second table is named by the module that owns
 * it, and `orphanSweep.test.ts` holds the swept set against the committed `gphone.sql` so a
 * future hand-written table cannot slip past the derivation the way this one did.
 */
export const AUDIT_LOG_TABLE = 'gphone_audit_logs';

type AuditAction =
  | 'archived'
  | 'unarchived'
  | 'deleted'
  | 'left'
  | 'removed'
  | 'moderated'
  /** A moderation reversed. Distinct from `unarchived` so the ledger reads honestly. */
  | 'unmoderated';

export interface AuditLogOptions {
  citizenid: string;
  action: AuditAction;
  /** The service that performed the action — `contacts`, `reports`. */
  service: string;
  method: string;
  targetId: number;
  targetTable?: string;
  details?: any;
}

export class AuditLogger {
  static async log(options: AuditLogOptions): Promise<boolean> {
    try {
      const query = `
                INSERT INTO ${AUDIT_LOG_TABLE}
                (citizenid, action, service, method, target_id, target_table, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
      const detailsJson = options.details ? JSON.stringify(options.details) : null;
      await Database.insert(query, [
        options.citizenid,
        options.action,
        options.service,
        options.method,
        options.targetId,
        options.targetTable || null,
        detailsJson
      ]);
      return true;
    } catch (error) {
      console.error('[AuditLogger] Failed to write audit log:', error);
      return false;
    }
  }
}
