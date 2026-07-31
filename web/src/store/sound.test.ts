import { describe, it, expect, beforeEach } from 'vitest';
import {
  soundService,
  soundMuted,
  soundVolume,
  soundVolumePercent,
  adjustVolume,
  setVolume,
  toggleMute
} from './sound';
import { get } from 'svelte/store';

describe('soundService', () => {
  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
  });

  it('allows updating volume and mute states', () => {
    soundVolume.set(0.8);
    expect(get(soundVolume)).toBe(0.8);

    soundMuted.set(true);
    expect(get(soundMuted)).toBe(true);
  });

  it('adjusts volume correctly with bounds checking', () => {
    adjustVolume(0.2);
    expect(get(soundVolume)).toBe(0.7);
    expect(get(soundVolumePercent)).toBe(70);

    adjustVolume(0.5); // should clamp to 1.0
    expect(get(soundVolume)).toBe(1.0);
    expect(get(soundVolumePercent)).toBe(100);

    adjustVolume(-1.5); // should clamp to 0.0
    expect(get(soundVolume)).toBe(0.0);
    expect(get(soundVolumePercent)).toBe(0);
    expect(get(soundMuted)).toBe(true);
  });

  it('toggles mute state', () => {
    expect(get(soundMuted)).toBe(false);
    toggleMute();
    expect(get(soundMuted)).toBe(true);
    expect(get(soundVolumePercent)).toBe(0);
  });

  it('triggers play method without throwing error', () => {
    expect(() => {
      soundService.play('click');
      soundService.play('pop');
      soundService.play('camera');
      soundService.play('notification');
    }).not.toThrow();
  });

  it('respects mute setting', () => {
    soundMuted.set(true);
    expect(() => {
      soundService.play('notification');
    }).not.toThrow();
  });
});
