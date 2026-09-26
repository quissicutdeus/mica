// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
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
  itemsBeyondCapacity,
  placeWidgetOnGrid,
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

    it('MICA-121: changes nothing and reports the count when the grid is entirely full', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      for (let p = 0; p < 12; p++) placeAppOnGrid(`app${p}`, p);
      homeGridItems.update((items) => [...items, { position: 50, kind: 'app', appId: 'overflow' }]);
      const before = get(homeGridItems);

      const blocked = compactGridToCurrentCapacity();

      expect(blocked).toBe(1);
      // Nothing moved and nothing was dropped — 'overflow' is still there, still at 50.
      expect(get(homeGridItems)).toEqual(before);
      expect(get(homeGridItems).find((i) => i.kind === 'app' && i.appId === 'overflow')).toEqual({
        position: 50,
        kind: 'app',
        appId: 'overflow'
      });
    });

    it('MICA-121: still refuses, and drops nothing, with several items beyond capacity', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      for (let p = 0; p < 12; p++) placeAppOnGrid(`app${p}`, p);
      homeGridItems.update((items) => [
        ...items,
        { position: 50, kind: 'app', appId: 'overflow1' },
        { position: 51, kind: 'app', appId: 'overflow2' },
        { position: 52, kind: 'app', appId: 'overflow3' }
      ]);
      const before = get(homeGridItems);

      const blocked = compactGridToCurrentCapacity();

      expect(blocked).toBe(3);
      expect(get(homeGridItems)).toEqual(before);
      expect(get(homeGridItems)).toHaveLength(15);
    });

    it('returns 0 once everything is already in bounds', () => {
      placeAppOnGrid('notes', 3);
      expect(compactGridToCurrentCapacity()).toBe(0);
    });
  });

  describe('itemsBeyondCapacity', () => {
    it('is 0 when everything already fits', () => {
      placeAppOnGrid('notes', 3);
      expect(itemsBeyondCapacity(20)).toBe(0);
    });

    it('counts exactly how many items a smaller capacity could not hold', () => {
      for (let p = 0; p < 5; p++) placeAppOnGrid(`app${p}`, p);
      expect(itemsBeyondCapacity(12)).toBe(0);
      expect(itemsBeyondCapacity(3)).toBe(2);
      expect(itemsBeyondCapacity(0)).toBe(5);
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

describe('widgets (MICA-245)', () => {
  const widget = (position: number, size: '2x1' | '2x2' = '2x1', widgetId = 'shell.clock') =>
    ({ position, kind: 'widget', widgetId, size }) as const;

  beforeEach(() => {
    homeGridItems.set([]);
    homeGridColumns.set(4);
    homeGridRows.set(5);
  });

  it('a widget occupies every cell of its footprint', () => {
    homeGridItems.set([widget(1, '2x2')]);
    const items = get(homeGridItems);
    for (const cell of [1, 2, 5, 6]) expect(isGridCellOccupied(cell, items)).toBe(true);
    for (const cell of [0, 3, 4, 7]) expect(isGridCellOccupied(cell, items)).toBe(false);
  });

  it('places a widget at the first free rectangle and never straddles a row end', () => {
    for (const p of [0, 1]) placeAppOnGrid(`app${p}`, p);
    expect(placeWidgetOnGrid('shell.clock', '2x1')).toBe('placed');
    expect(get(homeGridItems).find((i) => i.kind === 'widget')?.position).toBe(2);
    homeGridItems.set(
      [0, 1, 2].map((p) => ({ position: p, kind: 'app', appId: `a${p}` }) as const)
    );
    expect(placeWidgetOnGrid('shell.status', '2x2')).toBe('placed');
    // Position 3 is free but would straddle the row end, so the first fit is 4.
    expect(get(homeGridItems).find((i) => i.kind === 'widget')?.position).toBe(4);
  });

  it('refuses a second instance of the same widget', () => {
    expect(placeWidgetOnGrid('shell.clock', '2x1')).toBe('placed');
    expect(placeWidgetOnGrid('shell.clock', '2x2')).toBe('rejected');
  });

  it('an icon dropped on a widget is refused', () => {
    homeGridItems.set([widget(0, '2x2')]);
    expect(placeAppOnGrid('notes', 5)).toBe('rejected');
    expect(get(homeGridItems)).toHaveLength(1);
  });

  it('moves a widget, nudging it in from the right edge, and refuses a collision', () => {
    homeGridItems.set([widget(0), { position: 9, kind: 'app', appId: 'notes' }]);
    expect(moveGridItem(0, 7)).toBe('placed'); // col 3 nudged to col 2
    expect(get(homeGridItems).find((i) => i.kind === 'widget')?.position).toBe(6);
    expect(moveGridItem(6, 9)).toBe('rejected'); // 9 is an icon
  });

  it('removes a widget by its anchor', () => {
    homeGridItems.set([widget(2, '2x2')]);
    removeFromGrid(2);
    expect(get(homeGridItems)).toEqual([]);
  });

  it('shrinking 5 -> 4 -> 3 columns keeps the widget, and moves the icon under it', () => {
    homeGridColumns.set(5);
    homeGridRows.set(6);
    homeGridItems.set([widget(3, '2x2'), { position: 0, kind: 'app', appId: 'notes' }]);
    for (const columns of [4, 3]) {
      expect(itemsBeyondCapacity(columns * 6, columns)).toBe(0);
      homeGridColumns.set(columns);
      expect(compactGridToCurrentCapacity()).toBe(0);
      const w = get(homeGridItems).find((i) => i.kind === 'widget')!;
      expect(w.position % columns).toBeLessThanOrEqual(columns - 2);
      expect(get(homeGridItems)).toHaveLength(2);
    }
  });

  it('an icon that a reflowed widget lands on moves to the next free cell', () => {
    homeGridItems.set([widget(3), { position: 1, kind: 'app', appId: 'notes' }]);
    homeGridColumns.set(3); // widget at 3 is now col 0, row 1 -> fine; force a collision instead
    homeGridItems.set([widget(2), { position: 3, kind: 'app', appId: 'notes' }]);
    expect(compactGridToCurrentCapacity()).toBe(0);
    const items = get(homeGridItems);
    const w = items.find((i) => i.kind === 'widget')!;
    const icon = items.find((i) => i.kind === 'app')!;
    expect(w.position % 3).toBeLessThanOrEqual(1);
    expect(isGridCellOccupied(icon.position, [w])).toBe(false);
  });

  it('refuses a shrink that cannot hold the widgets, and changes nothing', () => {
    homeGridColumns.set(3);
    homeGridRows.set(4);
    homeGridItems.set([widget(0, '2x2', 'a'), widget(6, '2x2', 'b'), widget(2, '2x2', 'c')]);
    // 12 cells of widget in a 12-cell grid, and the third still cannot be packed.
    expect(itemsBeyondCapacity(12, 3)).toBe(1);
    const before = get(homeGridItems);
    expect(compactGridToCurrentCapacity()).toBe(1);
    expect(get(homeGridItems)).toEqual(before);
  });

  describe('persistence shape', () => {
    it('accepts a widget and drops a malformed one', () => {
      expect(sanitizeHomeGridItems([widget(0)])).toHaveLength(1);
      expect(
        sanitizeHomeGridItems([{ position: 0, kind: 'widget', widgetId: 'x', size: '3x3' }])
      ).toEqual([]);
      expect(sanitizeHomeGridItems([{ position: 0, kind: 'widget', size: '2x1' }])).toEqual([]);
    });

    it('legacy layouts with only apps and folders load unchanged', () => {
      const legacy = [
        { position: 0, kind: 'app', appId: 'notes' },
        { position: 4, kind: 'folder', folderId: 'f', name: 'F', appIds: ['mail'] }
      ];
      expect(sanitizeHomeGridItems(legacy)).toEqual(legacy);
    });

    it('keeps an unknown widgetId — it is the registry that hides it, not the data', () => {
      const kept = sanitizeHomeGridItems([widget(0, '2x1', 'uninstalled-app')]);
      expect(kept).toEqual([widget(0, '2x1', 'uninstalled-app')]);
    });
  });
});
