// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
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
  ringtoneChoices,
  notificationTone,
  setNotificationTone,
  notificationToneChoices
} from './audio';
import { ownerConfig, DEFAULT_OWNER_CONFIG } from './ownerConfig';
import type { RingMode } from '../../../../sdk/vocabulary/audio';
import { get } from 'svelte/store';
import { useStorage } from '../../../../sdk/host/useStorage';
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

    setRingtone('foghorn');
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

describe('owner sounds (MICA-256)', () => {
  const URL_A = 'https://cfx-nui-mica/branding/sounds/Bell.ogg';
  let ctx: ReturnType<typeof fakeAudioContext> & { decodeAudioData: ReturnType<typeof vi.fn> };
  let sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>;

  const setSounds = (sounds: Array<{ id: string; label: string; url: string }>) =>
    ownerConfig.set({ ...DEFAULT_OWNER_CONFIG, sounds });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
    setRingMode('normal');
    setRingtone('classic');
    setNotificationTone('default');
    setSounds([{ id: 'owner:Bell', label: 'Bell', url: URL_A }]);
    sources = [];
    const base = fakeAudioContext();
    ctx = {
      ...base,
      decodeAudioData: vi.fn(async () => ({ duration: 1 }) as AudioBuffer),
      createBufferSource: vi.fn(() => {
        const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        sources.push(source);
        return source;
      })
    };
    (audio as unknown as { audioCtx: unknown }).audioCtx = ctx;
    const svc = audio as unknown as Record<string, Map<string, unknown> | Set<string>>;
    svc.buffers.clear();
    svc.pending.clear();
    svc.failed.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setRingtone('classic');
    setNotificationTone('default');
    ownerConfig.set(DEFAULT_OWNER_CONFIG);
    (audio as unknown as { audioCtx: unknown }).audioCtx = null;
  });

  it('lists owner sounds after the built-ins, in both pickers', () => {
    expect(get(ringtoneChoices).map((o) => o.id)).toEqual([
      ...RINGTONE_OPTIONS.map((o) => o.id),
      'owner:Bell'
    ]);
    // No synthetic "Default" row here — that label belongs to a component with
    // `useLocale`, not this store. `Sound.test.ts` covers the merged, translated list.
    expect(get(notificationToneChoices).map((o) => o.id)).toEqual(['owner:Bell']);
  });

  it('keeps an owner id chosen before the config loaded, and refuses a malformed one', () => {
    ownerConfig.set(DEFAULT_OWNER_CONFIG);
    setRingtone('owner:Bell');
    expect(get(ringtone)).toBe('owner:Bell');
    setRingtone('owner:');
    expect(get(ringtone)).toBe('classic');
    setNotificationTone('foghorn');
    expect(get(notificationTone)).toBe('default');
  });

  it('plays a chosen owner sound from its cfx-nui URL, decoded once and cached', async () => {
    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    expect(fetch).toHaveBeenCalledWith(URL_A);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.start).toHaveBeenCalled();
    expect(ctx.createOscillator).not.toHaveBeenCalled();

    audio.play('ringtone');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.stop).toHaveBeenCalled();
  });

  it('a contact override wins over the system ringtone', async () => {
    audio.play('ringtone', { tone: 'owner:Bell' });
    await flush();
    expect(sources).toHaveLength(1);
  });

  it('the notification tone is separate from the ring', async () => {
    setNotificationTone('owner:Bell');
    audio.play('ringtone');
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(sources).toHaveLength(0);
    ctx.createOscillator.mockClear();
    audio.play('notification');
    await flush();
    expect(sources).toHaveLength(1);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('an unknown id falls back to the built-in default, never silence', () => {
    setRingtone('owner:Gone');
    audio.play('ringtone');
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a file that will not decode warns once and plays the built-in tone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.decodeAudioData.mockRejectedValue(new Error('bad data'));
    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    ctx.createOscillator.mockClear();
    audio.play('ringtone');
    await flush();
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch falls back to the default notification chime', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }))
    );
    setNotificationTone('owner:Bell');
    audio.play('notification');
    await flush();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('never fetches a URL outside the resource, including one shaped like a valid host', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const urls = [
      'https://evil.example/a.ogg',
      '//evil.example/a.ogg',
      'http://x/a.ogg',
      // Shaped exactly like the real thing, for a resource that is not this one — the
      // bare `https://cfx-nui-` prefix used to accept this (MICA-256 review).
      'https://cfx-nui-otherresource/branding/sounds/a.ogg'
    ];
    for (const url of urls) {
      setSounds([{ id: 'owner:Bell', label: 'Bell', url }]);
      setRingtone('owner:Bell');
      audio.play('ringtone');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.createOscillator).toHaveBeenCalled();
  });

  it('previews an owner sound and answers to mute', async () => {
    audio.preview('owner:Bell');
    await flush();
    expect(sources).toHaveLength(1);
    soundMuted.set(true);
    audio.previewNotification('owner:Bell');
    await flush();
    expect(sources).toHaveLength(1);
  });

  it('stopRing silences a playing owner ring, and disarms a cold load already in flight — even the fallback', async () => {
    let resolveDecode!: (buffer: AudioBuffer) => void;
    ctx.decodeAudioData.mockImplementation(
      () => new Promise<AudioBuffer>((resolve) => (resolveDecode = resolve))
    );
    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush(); // fetch + arrayBuffer settle; decodeAudioData is now pending

    audio.stopRing(); // the call ended before the file finished decoding
    resolveDecode({ duration: 1 } as AudioBuffer);
    await flush();

    expect(sources).toHaveLength(0); // the owner buffer never started
    expect(ctx.createOscillator).not.toHaveBeenCalled(); // nor the built-in fallback
  });

  it('stopRing stops an already-playing owner ring outright', async () => {
    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    expect(sources).toHaveLength(1);

    audio.stopRing();
    expect(sources[0]?.stop).toHaveBeenCalled();
  });

  it('a failed fetch is retried after the cooldown, not on every attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = vi.fn<
      () => Promise<{ ok: boolean; status?: number; arrayBuffer?: () => Promise<ArrayBuffer> }>
    >(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 10_000); // still inside the 30s cooldown
    audio.play('ringtone');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 30_001); // past it
    fetchMock.mockImplementation(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8)
    }));
    audio.play('ringtone');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(1);
  });

  it('forgets a failure the moment the owner config changes, rather than waiting out the cooldown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }))
    );
    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    setSounds([{ id: 'owner:Bell', label: 'Bell', url: URL_A }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    );
    audio.play('ringtone');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
  });

  it('keeps only the selected ring and notification buffers plus one previewed extra', async () => {
    const urlB = 'https://cfx-nui-mica/branding/sounds/Chime2.ogg';
    const urlC = 'https://cfx-nui-mica/branding/sounds/Gong.ogg';
    const urlD = 'https://cfx-nui-mica/branding/sounds/Extra.ogg';
    setSounds([
      { id: 'owner:Bell', label: 'Bell', url: URL_A },
      { id: 'owner:Chime2', label: 'Chime2', url: urlB },
      { id: 'owner:Gong', label: 'Gong', url: urlC },
      { id: 'owner:Extra', label: 'Extra', url: urlD }
    ]);
    const buffers = (audio as unknown as { buffers: Map<string, unknown> }).buffers;

    setRingtone('owner:Bell');
    audio.play('ringtone');
    await flush();
    setNotificationTone('owner:Chime2');
    audio.play('notification');
    await flush();
    audio.preview('owner:Gong');
    await flush();
    expect([...buffers.keys()].sort()).toEqual([URL_A, urlB, urlC].sort());

    // A second preview evicts the first preview's buffer immediately — before its own
    // fetch even resolves — because it is no longer anything `keepUrls` retains.
    audio.preview('owner:Extra');
    expect(buffers.has(urlC)).toBe(false);
    await flush();
    expect([...buffers.keys()].sort()).toEqual([URL_A, urlB, urlD].sort());
  });
});
