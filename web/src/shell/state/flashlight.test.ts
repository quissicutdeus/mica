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
