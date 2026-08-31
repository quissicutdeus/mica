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
import {
  isShadeOpen,
  openShade,
  closeShade,
  toggleShade,
  shadeDragProgress,
  shadeDragPhase
} from './shade';
import { activeHandlerFor } from './keybinds';

describe('Notification Shade State', () => {
  beforeEach(() => {
    closeShade();
  });

  it('defaults to closed', () => {
    expect(get(isShadeOpen)).toBe(false);
  });

  it('opens and closes shade', () => {
    openShade();
    expect(get(isShadeOpen)).toBe(true);

    closeShade();
    expect(get(isShadeOpen)).toBe(false);
  });

  it('toggles shade state', () => {
    toggleShade();
    expect(get(isShadeOpen)).toBe(true);

    toggleShade();
    expect(get(isShadeOpen)).toBe(false);
  });

  it('reclaims back keybind while open and restores it when closed', () => {
    openShade();
    const handler = activeHandlerFor('back');
    expect(handler).toBeDefined();

    handler!();
    expect(get(isShadeOpen)).toBe(false);
  });

  describe('drag state', () => {
    beforeEach(() => {
      shadeDragProgress.set(0);
      shadeDragPhase.set('idle');
    });

    it('defaults to closed progress and an idle phase', () => {
      expect(get(shadeDragProgress)).toBe(0);
      expect(get(shadeDragPhase)).toBe('idle');
    });

    it('is independently mutable and has no side effect on isShadeOpen or the back keybind', () => {
      shadeDragProgress.set(0.4);
      shadeDragPhase.set('dragging');

      expect(get(isShadeOpen)).toBe(false);
      expect(activeHandlerFor('back')).toBeUndefined();

      shadeDragProgress.set(1);
      shadeDragPhase.set('settling');

      expect(get(isShadeOpen)).toBe(false);
      expect(activeHandlerFor('back')).toBeUndefined();
    });

    it('only openShade/closeShade — not the drag stores — register or release the back keybind', () => {
      shadeDragProgress.set(1);
      shadeDragPhase.set('settling');
      expect(activeHandlerFor('back')).toBeUndefined();

      openShade();
      expect(activeHandlerFor('back')).toBeDefined();

      shadeDragPhase.set('idle');
      expect(activeHandlerFor('back')).toBeDefined();

      closeShade();
      expect(activeHandlerFor('back')).toBeUndefined();
    });
  });
});
