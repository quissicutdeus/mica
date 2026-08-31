/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  iconDragState,
  startIconDrag,
  moveIconDrag,
  cancelIconDrag,
  endIconDrag,
  isRemovableOrigin,
  resolveIconDrop
} from './iconDrag';
import { dockAppIds, DEFAULT_DOCK_APP_IDS } from './dock';
import { homeGridItems, type HomeGridFolder } from './homeGrid';
import { homeGridColumns, homeGridRows } from './homeGridSettings';

describe('Icon drag session', () => {
  beforeEach(() => {
    cancelIconDrag();
    dockAppIds.set([...DEFAULT_DOCK_APP_IDS]);
    homeGridItems.set([]);
    homeGridColumns.set(4);
    homeGridRows.set(5);
  });

  it('starts idle', () => {
    expect(get(iconDragState)).toEqual({ appId: null, origin: null, x: 0, y: 0, manifest: null });
  });

  it('start/move/cancel', () => {
    startIconDrag('notes', { kind: 'drawer' }, 1, 2);
    expect(get(iconDragState).appId).toBe('notes');

    moveIconDrag(5, 6);
    expect(get(iconDragState)).toMatchObject({ x: 5, y: 6, appId: 'notes' });

    cancelIconDrag();
    expect(get(iconDragState).appId).toBeNull();
  });

  it('endIconDrag clears the session', () => {
    startIconDrag('notes', { kind: 'drawer' }, 1, 2);
    endIconDrag();
    expect(get(iconDragState).appId).toBeNull();
  });

  describe('resolveIconDrop', () => {
    it('no-op when nothing is dragging', () => {
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 0 })).toBe('no-op');
    });

    it('drawer -> empty grid cell places the app', () => {
      startIconDrag('notes', { kind: 'drawer' }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 3 })).toBe('placed');
      expect(get(homeGridItems)).toEqual([{ position: 3, kind: 'app', appId: 'notes' }]);
      expect(get(iconDragState).appId).toBeNull();
    });

    it('drawer -> nothing (target: none) cancels cleanly', () => {
      startIconDrag('notes', { kind: 'drawer' }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'none' })).toBe('rejected');
      expect(get(homeGridItems)).toEqual([]);
      expect(get(iconDragState).appId).toBeNull();
    });

    it('grid -> empty grid cell moves the app', () => {
      homeGridItems.set([{ position: 3, kind: 'app', appId: 'notes' }]);
      startIconDrag('notes', { kind: 'grid', position: 3 }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 7 })).toBe('placed');
      expect(get(homeGridItems)).toEqual([{ position: 7, kind: 'app', appId: 'notes' }]);
    });

    it('grid -> another app creates a folder', () => {
      homeGridItems.set([
        { position: 3, kind: 'app', appId: 'notes' },
        { position: 7, kind: 'app', appId: 'mail' }
      ]);
      startIconDrag('notes', { kind: 'grid', position: 3 }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 7 })).toBe(
        'folder-created'
      );
      const items = get(homeGridItems);
      expect(items).toHaveLength(1);
      expect((items[0] as HomeGridFolder).appIds).toEqual(['mail', 'notes']);
    });

    it('drawer -> dock places the app in that slot', () => {
      startIconDrag('notes', { kind: 'drawer' }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'dock', index: 1 })).toBe('placed');
      expect(get(dockAppIds)[1]).toBe('notes');
    });

    it('grid -> dock removes the app from the grid and places it in the dock', () => {
      homeGridItems.set([{ position: 3, kind: 'app', appId: 'notes' }]);
      startIconDrag('notes', { kind: 'grid', position: 3 }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'dock', index: 0 })).toBe('placed');
      expect(get(dockAppIds)[0]).toBe('notes');
      expect(get(homeGridItems)).toEqual([]);
    });

    it('dock -> grid removes the app from the dock and places it on the grid', () => {
      startIconDrag('phone', { kind: 'dock', index: 0 }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 5 })).toBe('placed');
      expect(get(dockAppIds)[0]).toBe('');
      expect(get(homeGridItems)).toEqual([{ position: 5, kind: 'app', appId: 'phone' }]);
    });

    it('folder -> grid removes the app from the folder and places it at the target', () => {
      homeGridItems.set([
        { position: 3, kind: 'folder', folderId: 'f1', name: '', appIds: ['notes', 'mail'] }
      ]);
      startIconDrag('mail', { kind: 'folder', folderId: 'f1' }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 9 })).toBe('placed');
      const items = get(homeGridItems);
      expect((items.find((i) => i.kind === 'folder') as HomeGridFolder).appIds).toEqual(['notes']);
      expect(items.find((i) => i.kind === 'app' && i.appId === 'mail')?.position).toBe(9);
    });

    /**
     * MICA-87. Before this, every removal was a side effect of putting the app
     * somewhere else and a drop that hit nothing cancelled — so a pinned icon could be
     * moved forever and never taken off the home screen.
     */
    describe('remove', () => {
      it('grid -> remove takes the app off the home screen', () => {
        homeGridItems.set([
          { position: 3, kind: 'app', appId: 'notes' },
          { position: 4, kind: 'app', appId: 'mail' }
        ]);
        startIconDrag('notes', { kind: 'grid', position: 3 }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('removed');
        expect(get(homeGridItems)).toEqual([{ position: 4, kind: 'app', appId: 'mail' }]);
        expect(get(iconDragState).appId).toBeNull();
      });

      it('grid -> remove takes a whole folder off, apps included', () => {
        homeGridItems.set([
          { position: 2, kind: 'folder', folderId: 'f1', name: 'Stuff', appIds: ['notes', 'mail'] }
        ]);
        startIconDrag('f1', { kind: 'grid', position: 2 }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('removed');
        expect(get(homeGridItems)).toEqual([]);
      });

      it('folder -> remove pulls the app out without placing it anywhere', () => {
        homeGridItems.set([
          { position: 3, kind: 'folder', folderId: 'f1', name: '', appIds: ['notes', 'mail'] }
        ]);
        startIconDrag('mail', { kind: 'folder', folderId: 'f1' }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('removed');
        const items = get(homeGridItems);
        expect((items[0] as HomeGridFolder).appIds).toEqual(['notes']);
        expect(items.some((i) => i.kind === 'app' && i.appId === 'mail')).toBe(false);
      });

      it('folder -> remove drops the folder too once it is empty', () => {
        homeGridItems.set([
          { position: 3, kind: 'folder', folderId: 'f1', name: '', appIds: ['mail'] }
        ]);
        startIconDrag('mail', { kind: 'folder', folderId: 'f1' }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('removed');
        expect(get(homeGridItems)).toEqual([]);
      });

      it('dock -> remove empties that slot without shrinking the dock', () => {
        startIconDrag('phone', { kind: 'dock', index: 0 }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('removed');
        expect(get(dockAppIds)[0]).toBe('');
        expect(get(dockAppIds)).toHaveLength(DEFAULT_DOCK_APP_IDS.length);
      });

      it('drawer -> remove is rejected and mutates nothing', () => {
        homeGridItems.set([{ position: 3, kind: 'app', appId: 'notes' }]);
        startIconDrag('notes', { kind: 'drawer' }, 0, 0);
        expect(resolveIconDrop(get(iconDragState), { kind: 'remove' })).toBe('rejected');
        expect(get(homeGridItems)).toEqual([{ position: 3, kind: 'app', appId: 'notes' }]);
        expect(get(iconDragState).appId).toBeNull();
      });

      it('offers removal from every origin except the drawer', () => {
        expect(isRemovableOrigin(null)).toBe(false);
        expect(isRemovableOrigin({ kind: 'drawer' })).toBe(false);
        expect(isRemovableOrigin({ kind: 'grid', position: 0 })).toBe(true);
        expect(isRemovableOrigin({ kind: 'dock', index: 0 })).toBe(true);
        expect(isRemovableOrigin({ kind: 'folder', folderId: 'f1' })).toBe(true);
      });
    });

    it('rejects dropping onto a full folder and leaves the folder untouched', () => {
      homeGridColumns.set(3);
      homeGridRows.set(4); // capacity 12
      const appIds = Array.from({ length: 12 }, (_, i) => `app${i}`);
      homeGridItems.set([{ position: 0, kind: 'folder', folderId: 'f1', name: '', appIds }]);
      startIconDrag('g', { kind: 'drawer' }, 0, 0);
      expect(resolveIconDrop(get(iconDragState), { kind: 'grid', position: 0 })).toBe('rejected');
      expect((get(homeGridItems)[0] as HomeGridFolder).appIds).toEqual(appIds);
    });
  });
});
