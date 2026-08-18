import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  homeGridItems,
  placeAppOnGrid,
  moveGridItem,
  removeFromGrid,
  renameFolder,
  removeAppFromFolder,
  removeAppFromFolderOnly,
  sanitizeHomeGridItems,
  isGridCellOccupied,
  compactGridToCurrentCapacity,
  type HomeGridFolder
} from './homeGrid';
import { homeGridColumns, homeGridRows } from './homeGridSettings';

describe('Home grid state', () => {
  beforeEach(() => {
    homeGridItems.set([]);
    homeGridColumns.set(4);
    homeGridRows.set(5); // capacity 20
  });

  it('defaults to an empty grid', () => {
    expect(get(homeGridItems)).toEqual([]);
  });

  describe('placeAppOnGrid', () => {
    it('places an app on an empty cell', () => {
      expect(placeAppOnGrid('notes', 3)).toBe('placed');
      expect(get(homeGridItems)).toEqual([{ position: 3, kind: 'app', appId: 'notes' }]);
    });

    it('creates a folder when dropped on a different single app', () => {
      placeAppOnGrid('notes', 3);
      expect(placeAppOnGrid('mail', 3)).toBe('folder-created');
      const items = get(homeGridItems);
      expect(items).toHaveLength(1);
      const folder = items[0] as HomeGridFolder;
      expect(folder.kind).toBe('folder');
      expect(folder.name).toBe('');
      expect(folder.appIds).toEqual(['notes', 'mail']);
    });

    it('rejects dropping an app onto itself', () => {
      placeAppOnGrid('notes', 3);
      expect(placeAppOnGrid('notes', 3)).toBe('rejected');
      expect(get(homeGridItems)).toEqual([{ position: 3, kind: 'app', appId: 'notes' }]);
    });

    it('adds to an existing folder under capacity', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 3);
      expect(placeAppOnGrid('bank', 3)).toBe('added-to-folder');
      const folder = get(homeGridItems)[0] as HomeGridFolder;
      expect(folder.appIds).toEqual(['notes', 'mail', 'bank']);
    });

    it('rejects an app already in the target folder', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 3);
      expect(placeAppOnGrid('notes', 3)).toBe('rejected');
    });

    it('rejects adding to a folder at capacity', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12, but folder cap uses grid capacity
      const apps = Array.from({ length: 12 }, (_, i) => `app${i}`);
      placeAppOnGrid(apps[0], 3);
      placeAppOnGrid(apps[1], 3);
      for (let i = 2; i < 12; i++) {
        expect(placeAppOnGrid(apps[i], 3)).toBe('added-to-folder');
      }
      expect(placeAppOnGrid('one-too-many', 3)).toBe('rejected');
    });
  });

  describe('moveGridItem', () => {
    it('moves an app to an empty cell, vacating the old one', () => {
      placeAppOnGrid('notes', 3);
      expect(moveGridItem(3, 7)).toBe('placed');
      expect(get(homeGridItems)).toEqual([{ position: 7, kind: 'app', appId: 'notes' }]);
    });

    it('creates a folder when moved onto a different app', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 7);
      expect(moveGridItem(3, 7)).toBe('folder-created');
      const items = get(homeGridItems);
      expect(items).toHaveLength(1);
      expect((items[0] as HomeGridFolder).appIds).toEqual(['mail', 'notes']);
    });

    it('rejects moving onto the same position', () => {
      placeAppOnGrid('notes', 3);
      expect(moveGridItem(3, 3)).toBe('rejected');
    });

    it('rejects moving a non-existent source', () => {
      expect(moveGridItem(3, 7)).toBe('rejected');
    });

    it('moves a folder only onto an empty cell, never merging into another item', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 3);
      placeAppOnGrid('bank', 7);
      expect(moveGridItem(3, 7)).toBe('rejected');
      expect(moveGridItem(3, 10)).toBe('placed');
      const items = get(homeGridItems);
      expect(items.find((i) => i.position === 10)?.kind).toBe('folder');
    });
  });

  describe('removeFromGrid', () => {
    it('clears whatever occupies the cell', () => {
      placeAppOnGrid('notes', 3);
      removeFromGrid(3);
      expect(get(homeGridItems)).toEqual([]);
    });
  });

  describe('folders', () => {
    it('renames a folder', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 3);
      const folderId = (get(homeGridItems)[0] as HomeGridFolder).folderId;
      renameFolder(folderId, 'Work');
      expect((get(homeGridItems)[0] as HomeGridFolder).name).toBe('Work');
    });

    it('removeAppFromFolderOnly drops the app and deletes an emptied folder', () => {
      placeAppOnGrid('notes', 3);
      placeAppOnGrid('mail', 3);
      const folderId = (get(homeGridItems)[0] as HomeGridFolder).folderId;
      removeAppFromFolderOnly(folderId, 'notes');
      expect((get(homeGridItems)[0] as HomeGridFolder).appIds).toEqual(['mail']);
      removeAppFromFolderOnly(folderId, 'mail');
      expect(get(homeGridItems)).toEqual([]);
    });

    it('removeAppFromFolder returns the app to the grid at the first free cell', () => {
      placeAppOnGrid('notes', 0);
      placeAppOnGrid('mail', 0);
      placeAppOnGrid('bank', 1);
      const folderId = (get(homeGridItems).find((i) => i.kind === 'folder') as HomeGridFolder)
        .folderId;
      expect(removeAppFromFolder(folderId, 'mail')).toBe(true);
      const items = get(homeGridItems);
      expect(items.find((i) => i.kind === 'app' && i.appId === 'mail')?.position).toBe(2);
    });

    it('removeAppFromFolder fails cleanly when the grid is entirely full', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      placeAppOnGrid('notes', 0);
      placeAppOnGrid('mail', 0);
      for (let p = 1; p < 12; p++) placeAppOnGrid(`app${p}`, p);
      const folderId = (get(homeGridItems).find((i) => i.kind === 'folder') as HomeGridFolder)
        .folderId;
      expect(removeAppFromFolder(folderId, 'mail')).toBe(false);
      // Nothing changed — the app is still in the folder.
      const folder = get(homeGridItems).find((i) => i.kind === 'folder') as HomeGridFolder;
      expect(folder.appIds).toContain('mail');
    });
  });

  describe('compactGridToCurrentCapacity', () => {
    it('does nothing when every item is already in bounds', () => {
      placeAppOnGrid('notes', 3);
      compactGridToCurrentCapacity();
      expect(get(homeGridItems)).toEqual([{ position: 3, kind: 'app', appId: 'notes' }]);
    });

    it('reflows an out-of-range item into the first free in-bounds cell after a shrink', () => {
      homeGridColumns.set(4);
      homeGridRows.set(6); // capacity 24
      placeAppOnGrid('notes', 0);
      placeAppOnGrid('mail', 22); // will be out of range once the grid shrinks to 12

      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      compactGridToCurrentCapacity();

      const items = get(homeGridItems);
      expect(items.find((i) => i.kind === 'app' && i.appId === 'notes')?.position).toBe(0);
      const mail = items.find((i) => i.kind === 'app' && i.appId === 'mail');
      expect(mail).toBeDefined();
      expect(mail!.position).toBeLessThan(12);
      expect(mail!.position).not.toBe(0);
    });

    it('drops an out-of-range item that has nowhere to land once the grid is entirely full', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      for (let p = 0; p < 12; p++) placeAppOnGrid(`app${p}`, p);
      homeGridItems.update((items) => [...items, { position: 50, kind: 'app', appId: 'overflow' }]);

      compactGridToCurrentCapacity();

      expect(get(homeGridItems).some((i) => i.kind === 'app' && i.appId === 'overflow')).toBe(
        false
      );
      expect(get(homeGridItems)).toHaveLength(12);
    });
  });

  describe('isGridCellOccupied', () => {
    it('reflects the current items', () => {
      placeAppOnGrid('notes', 3);
      expect(isGridCellOccupied(3, get(homeGridItems))).toBe(true);
      expect(isGridCellOccupied(4, get(homeGridItems))).toBe(false);
    });
  });

  describe('sanitizeHomeGridItems', () => {
    it('rejects non-array input', () => {
      expect(sanitizeHomeGridItems(null)).toEqual([]);
      expect(sanitizeHomeGridItems('nope')).toEqual([]);
    });

    it('drops structurally invalid entries', () => {
      expect(
        sanitizeHomeGridItems([
          { position: -1, kind: 'app', appId: 'notes' },
          { position: 1, kind: 'app' },
          { position: 2, kind: 'folder', folderId: 'f1', name: '', appIds: ['a'] },
          'garbage',
          null
        ])
      ).toEqual([{ position: 2, kind: 'folder', folderId: 'f1', name: '', appIds: ['a'] }]);
    });

    it('dedupes by position, first wins', () => {
      const result = sanitizeHomeGridItems([
        { position: 1, kind: 'app', appId: 'notes' },
        { position: 1, kind: 'app', appId: 'mail' }
      ]);
      expect(result).toEqual([{ position: 1, kind: 'app', appId: 'notes' }]);
    });

    it('dedupes by app id, last wins', () => {
      const result = sanitizeHomeGridItems([
        { position: 1, kind: 'app', appId: 'notes' },
        { position: 2, kind: 'app', appId: 'notes' }
      ]);
      expect(result).toEqual([{ position: 2, kind: 'app', appId: 'notes' }]);
    });
  });
});
