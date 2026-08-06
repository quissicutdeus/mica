import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { isShadeOpen, openShade, closeShade, toggleShade } from './shade';
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
});
