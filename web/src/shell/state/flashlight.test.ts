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
