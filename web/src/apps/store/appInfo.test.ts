// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
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
