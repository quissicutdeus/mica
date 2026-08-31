/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { flashlightEnabled, toggleFlashlight, setFlashlightEnabled } from './flashlight';

describe('Flashlight Store', () => {
  beforeEach(() => {
    setFlashlightEnabled(false);
  });

  it('defaults Flashlight to disabled (OFF)', () => {
    expect(get(flashlightEnabled)).toBe(false);
  });

  it('toggles Flashlight state', () => {
    toggleFlashlight();
    expect(get(flashlightEnabled)).toBe(true);

    toggleFlashlight();
    expect(get(flashlightEnabled)).toBe(false);
  });
});
