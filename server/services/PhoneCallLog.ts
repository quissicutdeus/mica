import { defineService } from '../lib/defineService';
import { PhoneCallLogEntry } from '@shared/types';

/**
 * One row per participant, per call — read-only from the client. `Phone.ts` is the
 * only writer, via `phoneCallLog.repo.create(...)` called directly (never through a
 * NUI-facing action), which is what `write: 'server'` enforces: the generic
 * `create`/`update` actions are not registered at all.
 *
 * `paging` is declared even though an owner-scoped read does not require it:
 * `Repository.findAll` only applies `ORDER BY id DESC` when paging is present, and a
 * call log needs guaranteed newest-first order.
 */
export const phoneCallLog = defineService<PhoneCallLogEntry>({
  id: 'phone_call_log',
  access: { read: 'owner', write: 'server' },
  paging: {},
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    kind: { type: 'enum', values: ['incoming', 'outgoing', 'missed'], notNull: true },
    number: { type: 'string', length: 20, notNull: true },
    duration: { type: 'int', notNull: true }
  },
  indexes: [{ name: 'citizenid_status_created', columns: ['citizenid', 'status', 'created_at'] }],
  options: {
    // `write: 'server'` already turns off `create`/`update`. Delete stays owner-scoped
    // by default (a server-authored row still belongs to one citizenid) — turned off
    // explicitly here since this app has no delete feature, so nothing reachable goes
    // unused (server/__tests__/reachability.test.ts checks for exactly this).
    disableDelete: true
  }
});
