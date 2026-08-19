import { defineService } from '../lib/defineService';

/**
 * TODO: say what this service owns, and why any non-generic action exists.
 *
 * Repository, write allowlist, CRUD events and DDL are all derived from this. Run
 * `pnpm generate:sql` afterwards and apply the file.
 */
export const marketplace = defineService({
  id: 'marketplace',
  access: { read: 'owner', write: 'owner' },
  schema: {
    title: { type: 'string', length: 100, notNull: true }
  }
});
