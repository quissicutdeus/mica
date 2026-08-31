// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()` — see the commit
// message for why teaching that predicate to tolerate a missing `window` is the worse fix.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_DOCK_APP_IDS, dockAppIds, sanitizeDockAppIds, setDockSlot } from './dock';

describe('Dock state', () => {
  beforeEach(() => {
    dockAppIds.set([...DEFAULT_DOCK_APP_IDS]);
  });

  it('defaults to phone, messages, media, camera in order', () => {
    expect(get(dockAppIds)).toEqual(['phone', 'messages', 'media', 'camera']);
  });

  describe('sanitizeDockAppIds', () => {
    it('falls back to the default for non-array garbage', () => {
      expect(sanitizeDockAppIds(null)).toEqual(DEFAULT_DOCK_APP_IDS);
      expect(sanitizeDockAppIds('nope')).toEqual(DEFAULT_DOCK_APP_IDS);
      expect(sanitizeDockAppIds(42)).toEqual(DEFAULT_DOCK_APP_IDS);
    });

    it('caps at four slots, padding with empty strings', () => {
      expect(sanitizeDockAppIds(['a'])).toEqual(['a', '', '', '']);
      expect(sanitizeDockAppIds(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
    });

    it('drops non-string entries and blanks duplicates rather than collapsing the array', () => {
      expect(sanitizeDockAppIds(['a', 5, 'b'])).toEqual(['a', 'b', '', '']);
      expect(sanitizeDockAppIds(['a', 'a', 'b'])).toEqual(['a', '', 'b', '']);
    });

    it('tolerates an id the registry has not confirmed yet — it is not filtered out', () => {
      expect(sanitizeDockAppIds(['some_addon_not_yet_hydrated'])).toEqual([
        'some_addon_not_yet_hydrated',
        '',
        '',
        ''
      ]);
    });
  });

  describe('setDockSlot', () => {
    it('replaces one slot without touching the others', () => {
      setDockSlot(1, 'notes');
      expect(get(dockAppIds)).toEqual(['phone', 'notes', 'media', 'camera']);
    });

    it('moves an app rather than duplicating it across two slots', () => {
      setDockSlot(3, 'phone');
      expect(get(dockAppIds)).toEqual(['', 'messages', 'media', 'phone']);
    });

    it('ignores an out-of-range index', () => {
      setDockSlot(4, 'notes');
      expect(get(dockAppIds)).toEqual(DEFAULT_DOCK_APP_IDS);
    });
  });
});
