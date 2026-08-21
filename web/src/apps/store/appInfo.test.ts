import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS } from '../../sdk/manifest';
import { formatPermission } from './appInfo';

/**
 * Manual-check substitute for Step 8 of task-8: rather than opening the Store in dev and
 * clicking through every add-on's details, prove no permission name falls through to the
 * `formatPermission` fallback (which returns the raw name and the gear icon) by checking
 * every name in the vocabulary gets an actual label.
 */
describe('formatPermission', () => {
  it('gives every permission in the vocabulary a real label, never the raw name', () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(formatPermission(perm).label, `${perm} fell through to the default`).not.toBe(perm);
    }
  });
});
