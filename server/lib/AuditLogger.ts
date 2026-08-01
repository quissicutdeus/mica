import { Database } from './Database';

export type AuditAction =
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
                INSERT INTO gphone_audit_logs 
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
