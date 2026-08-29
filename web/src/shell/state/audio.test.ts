// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  audio,
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
  VOLUME_STEP_DEFAULT,
  ringMode,
  setRingMode,
  RING_MODE_CHOICES,
  ringtone,
  setRingtone,
  RINGTONE_OPTIONS,
  type RingMode,
  type RingtoneId
} from './audio';
import { get } from 'svelte/store';
import { useStorage } from '../../sdk/host/useStorage';
import { charge } from './charge';

describe('audio', () => {
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
      audio.play('click');
      audio.play('pop');
      audio.play('camera');
      audio.play('notification');
    }).not.toThrow();
  });

  it('warms audio context without throwing', () => {
    expect(() => {
      audio.warm();
    }).not.toThrow();
  });

  /**
   * `warm()` used to construct/resume the context eagerly on every call, which a plain
   * browser's autoplay policy always refuses before a real gesture — jsdom has no real
   * autoplay policy to observe that with, so this checks the thing that actually causes
   * it instead: `warm()` must not touch `AudioContext` at all in a browser (no
   * `window.invokeNative`, which is what `isBrowser()` keys on) until a real gesture
   * fires the `unlock` listener it attaches.
   */
  it('does not construct an AudioContext eagerly in a browser', () => {
    const ctor = vi.fn(function (this: unknown) {
      return { state: 'suspended', resume: () => Promise.resolve() };
    });
    (window as any).AudioContext = ctor;

    audio.warm();
    expect(ctor).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pointerdown'));
    expect(ctor).toHaveBeenCalledTimes(1);

    delete (window as any).AudioContext;
  });

  it('respects mute setting', () => {
    soundMuted.set(true);
    expect(() => {
      audio.play('notification');
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

  it('writes volume and mute to storage so a reload keeps them', () => {
    soundVolume.set(0.8);
    soundMuted.set(true);
    expect(useStorage('settings').getItem<number>('soundVolume')).toBe(0.8);
    expect(useStorage('settings').getItem<boolean>('soundMuted')).toBe(true);
  });
});

describe('while the battery is dead', () => {
  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
    charge.set(0);
  });

  afterEach(() => {
    // Module-scope store, so a value left at 0 would fail every other describe block
    // in this file depending on run order.
    charge.set(100);
  });

  it('refuses setVolume', () => {
    setVolume(0.9);
    expect(get(soundVolume)).toBe(0.5);
  });

  it('refuses adjustVolume', () => {
    adjustVolume(0.2);
    expect(get(soundVolume)).toBe(0.5);
  });

  it('refuses stepVolume', () => {
    stepVolume(1);
    expect(get(soundVolumePercent)).toBe(50);
  });

  it('refuses toggleMute', () => {
    toggleMute();
    expect(get(soundMuted)).toBe(false);
  });
});

/**
 * A stand-in for the Web Audio graph, counting the one thing that decides whether a sound
 * happened: whether an oscillator was ever created.
 *
 * jsdom has no `AudioContext`, so `SoundService` normally gives up before it schedules
 * anything and every `play()` assertion in this file above is only "it did not throw".
 * That is not enough for a mute switch — a ring mode that silently failed to suppress
 * would pass such a test — so these push a fake context into the service's cache and
 * assert against the graph it builds.
 */
const param = () => ({
  setValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn()
});

const fakeAudioContext = () => ({
  state: 'running',
  currentTime: 0,
  sampleRate: 44100,
  destination: {},
  resume: () => Promise.resolve(),
  createOscillator: vi.fn(() => ({
    type: 'sine',
    frequency: param(),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn()
  })),
  createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
  createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(8) })),
  createBufferSource: vi.fn(() => ({ buffer: null, connect: vi.fn(), start: vi.fn() }))
});

describe('ring mode', () => {
  let ctx: ReturnType<typeof fakeAudioContext>;

  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
    setRingMode('normal');
    setRingtone('classic');
    ctx = fakeAudioContext();
    // The service caches its context for the life of the module, so this is also what
    // keeps a fake from leaking into the suites above — see the afterEach.
    (audio as unknown as { audioCtx: unknown }).audioCtx = ctx;
  });

  afterEach(() => {
    setRingMode('normal');
    setRingtone('classic');
    (audio as unknown as { audioCtx: unknown }).audioCtx = null;
  });

  it('rings normally by default', () => {
    expect(get(ringMode)).toBe('normal');
    audio.play('ringtone');
    expect(ctx.createOscillator).toHaveBeenCalled();
  });

  it('silences the ringtone, the chime and the message pop on silent', () => {
    setRingMode('silent');

    audio.play('ringtone');
    audio.play('notification');
    audio.play('pop');

    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('silences the same three on vibrate, which has no haptics to offer instead', () => {
    setRingMode('vibrate');

    audio.play('ringtone');
    audio.play('notification');
    audio.play('pop');

    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  /**
   * The whole point of the mode existing rather than "turn the volume to zero": a phone on
   * silent still answers the finger touching it.
   */
  it('leaves the interface alone — a click is noise you caused', () => {
    setRingMode('silent');

    audio.play('click');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);

    audio.play('camera');
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('offers exactly the three modes, and refuses anything else', () => {
    expect(RING_MODE_CHOICES.map((choice) => choice.id)).toEqual(['normal', 'vibrate', 'silent']);

    for (const choice of RING_MODE_CHOICES) {
      setRingMode(choice.id);
      expect(get(ringMode)).toBe(choice.id);
    }

    // Persisted, so a hand-edited or stale entry must not leave the phone in a mode
    // nothing in the pane can get it out of.
    setRingMode('loud' as RingMode);
    expect(get(ringMode)).toBe('normal');
  });

  it('writes the mode to storage so a reload keeps it', () => {
    setRingMode('silent');
    expect(useStorage('settings').getItem<string>('ringMode')).toBe('silent');
  });
});

describe('ringtones', () => {
  let ctx: ReturnType<typeof fakeAudioContext>;

  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
    setRingMode('normal');
    setRingtone('classic');
    ctx = fakeAudioContext();
    (audio as unknown as { audioCtx: unknown }).audioCtx = ctx;
  });

  afterEach(() => {
    setRingMode('normal');
    setRingtone('classic');
    (audio as unknown as { audioCtx: unknown }).audioCtx = null;
  });

  it('defaults to the tone the phone has always rung with', () => {
    expect(get(ringtone)).toBe('classic');
    expect(RINGTONE_OPTIONS[0]?.id).toBe('classic');
  });

  it('offers several distinguishable tones, each with a label and a unique id', () => {
    expect(RINGTONE_OPTIONS.length).toBeGreaterThan(1);
    expect(new Set(RINGTONE_OPTIONS.map((o) => o.id)).size).toBe(RINGTONE_OPTIONS.length);
    for (const option of RINGTONE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('publishes ids and labels only, never the oscillator recipe behind them', () => {
    // An add-on that could read `notes` would be depending on a shape that changes every
    // time a tone is retuned.
    for (const option of RINGTONE_OPTIONS) {
      expect(Object.keys(option).sort()).toEqual(['id', 'label']);
    }
  });

  it('rings with whichever tone is chosen', () => {
    audio.play('ringtone');
    const classicNotes = ctx.createOscillator.mock.calls.length;
    expect(classicNotes).toBeGreaterThan(0);

    ctx.createOscillator.mockClear();
    setRingtone('ascent');
    audio.play('ringtone');
    expect(ctx.createOscillator.mock.calls.length).not.toBe(classicNotes);
  });

  it('accepts every offered tone and refuses anything else', () => {
    for (const option of RINGTONE_OPTIONS) {
      setRingtone(option.id);
      expect(get(ringtone)).toBe(option.id);
    }

    setRingtone('foghorn' as RingtoneId);
    expect(get(ringtone)).toBe('classic');
  });

  it('writes the choice to storage so a reload keeps it', () => {
    setRingtone('beacon');
    expect(useStorage('settings').getItem<string>('ringtone')).toBe('beacon');
  });

  /**
   * A preview button that does nothing while you are sitting in the pane that silenced it
   * is worse than no preview button.
   */
  it('previews through silent, because you asked for it', () => {
    setRingMode('silent');
    audio.preview('chime');
    expect(ctx.createOscillator).toHaveBeenCalled();
  });

  it('still respects mute, which is a statement about the speaker', () => {
    soundMuted.set(true);
    audio.preview('chime');
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });
});
