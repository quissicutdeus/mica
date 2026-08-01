import { describe, it, expect, beforeEach } from 'vitest';
import {
  soundService,
  soundMuted,
  soundVolume,
  soundVolumePercent,
  adjustVolume,
  setVolume,
  setVolumeStep,
  stepVolume,
  toggleMute,
  volumeStep,
  VOLUME_STEP_CHOICES,
  VOLUME_STEP_DEFAULT
} from './sound';
import { get } from 'svelte/store';
import { useStorage } from '../sdk/hooks/useStorage';

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

describe('volume buttons', () => {
  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
    setVolumeStep(VOLUME_STEP_DEFAULT);
  });

  it('defaults to 5% per press', () => {
    expect(get(volumeStep)).toBe(5);

    stepVolume(1);
    expect(get(soundVolumePercent)).toBe(55);

    stepVolume(-1);
    expect(get(soundVolumePercent)).toBe(50);
  });

  it('uses the configured step', () => {
    setVolumeStep(20);

    stepVolume(1);
    expect(get(soundVolumePercent)).toBe(70);
  });

  it('lands on round numbers over a run of presses', () => {
    // Accumulating 0.05 in floating point drifts; the HUD would show 5% while the
    // stored value behaved like 4.999999.
    soundVolume.set(0);
    soundMuted.set(false);
    for (let i = 0; i < 7; i++) stepVolume(1);
    expect(get(soundVolume)).toBe(0.35);
  });

  it('clamps at both ends', () => {
    setVolumeStep(20);
    for (let i = 0; i < 10; i++) stepVolume(1);
    expect(get(soundVolumePercent)).toBe(100);

    for (let i = 0; i < 10; i++) stepVolume(-1);
    expect(get(soundVolumePercent)).toBe(0);
  });

  it('unmutes on the way up, and mutes on reaching zero', () => {
    setVolumeStep(5);
    soundVolume.set(0.05);
    stepVolume(-1);
    expect(get(soundMuted)).toBe(true);

    stepVolume(1);
    expect(get(soundMuted)).toBe(false);
    expect(get(soundVolumePercent)).toBe(5);
  });

  it('rejects a step that is not one of the offered choices', () => {
    // The value is persisted, so a hand-edited or stale entry must not produce a phone
    // whose buttons move the volume by 3000%.
    setVolumeStep(9999);
    expect(get(volumeStep)).toBe(VOLUME_STEP_DEFAULT);

    setVolumeStep(NaN);
    expect(get(volumeStep)).toBe(VOLUME_STEP_DEFAULT);
  });

  it('accepts every offered choice', () => {
    for (const choice of VOLUME_STEP_CHOICES) {
      setVolumeStep(choice);
      expect(get(volumeStep)).toBe(choice);
    }
  });

  it('writes the step to storage so a reload keeps it', () => {
    // Asserted against storage rather than a re-imported module: the module is cached
    // for the whole run, so a second import would hand back the same live store and the
    // test would pass whether or not anything was ever written.
    setVolumeStep(10);
    expect(useStorage('settings').getItem<number>('volumeStep')).toBe(10);
  });
});
