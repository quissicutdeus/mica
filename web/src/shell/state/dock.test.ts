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
