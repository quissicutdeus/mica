// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, derived, get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { isBatteryDead } from './charge';
import { isBrowser } from '@mica/sdk';
import { isOwnerSoundId, isRingtoneValue } from '@mica/shared/ownerConfig';
import { ownerConfig } from './ownerConfig';
import type {
  RingMode,
  RingModeChoice,
  RingtoneId,
  RingtoneOption,
  SoundEffect
} from '../../../../sdk/vocabulary/audio';

const sanitizeVolume = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
};
export const soundVolume = usePersisted<number>('settings', 'soundVolume', 0.5, {
  sanitize: sanitizeVolume
});

const sanitizeMuted = (value: unknown): boolean => value === true;
export const soundMuted = usePersisted<boolean>('settings', 'soundMuted', false, {
  sanitize: sanitizeMuted
});

/**
 * Which noises the ring mode governs — the ones the phone makes *at* you.
 *
 * The line is between noise you caused and noise that arrives: a click is the feedback of
 * the control under your finger and a shutter is the camera you just fired, so both stay
 * on the system channel and answer to the volume alone. A ringtone, a notification chime
 * and a message pop are the phone interrupting you, which is the whole of what a person
 * means when they put a phone on silent.
 */
const ALERT_EFFECTS: ReadonlySet<SoundEffect> = new Set<SoundEffect>([
  'ringtone',
  'notification',
  'pop'
]);

/**
 * Silent is a mode, not a volume of zero. MICA-62.
 *
 * Turning `soundVolume` to zero was the only way to stop the phone ringing, and it took
 * the clicks, the camera and every notification with it — a player who wanted to sit
 * through a scene without their pocket chirping had to give up the interface's feedback
 * too, and then remember what the level used to be. This is the switch that separates the
 * two, stored beside `soundVolume` and `musicVolume` so all three of the phone's sound
 * preferences travel with the character together.
 *
 * **Silent suppresses audio and nothing else.** The incoming-call banner still appears
 * with its Accept button, and the in-game phone animation still plays: a call you cannot
 * hear is a quiet call, but a call you cannot *see* is an unanswerable one — the same
 * reasoning `notificationPolicy.ts` gives for why Do Not Disturb never withholds a call
 * banner.
 */
/**
 * **Vibrate is honest about being a label, for now.**
 *
 * There is no haptic device on the other side of this: micaOS renders in FiveM's CEF on a
 * desktop, and the buzz a real phone makes would have to come from the game — a
 * controller rumble or a prop animation out of `client/game/`, which is a native call and
 * not this file's to make. So vibrate silences the ringer exactly as silent does, and
 * differs from it only in being a *declared* state the client half can read when somebody
 * builds that. Naming it anything else would promise a buzz the phone cannot produce, and
 * the description below says so on screen rather than only in this comment.
 */
export const RING_MODE_CHOICES: readonly RingModeChoice[] = [
  {
    id: 'normal',
    label: 'Ring',
    description: 'Calls and notifications play out loud at the system volume.'
  },
  {
    id: 'vibrate',
    label: 'Vibrate',
    description: 'Silences the ringer. The phone has no haptics here, so nothing buzzes yet.'
  },
  {
    id: 'silent',
    label: 'Silent',
    description: 'No ring, no chime. Calls and banners still appear on screen.'
  }
];

const sanitizeRingMode = (value: unknown): RingMode =>
  value === 'vibrate' || value === 'silent' ? value : 'normal';

export const ringMode = usePersisted<RingMode>('settings', 'ringMode', 'normal', {
  sanitize: sanitizeRingMode
});

export const setRingMode = (mode: RingMode) => ringMode.set(sanitizeRingMode(mode));

/**
 * True while the phone must not make an alerting noise.
 *
 * Derived from the mode and consulted once, inside `SoundService.play`, rather than at
 * each of the four call sites in `toast.ts` — the same reasoning `musicOutputVolume` in
 * `shell/state/music.ts` gives for folding its mute into the output rather than checking
 * it per player. Folding the switch into the path the sound already takes is what makes
 * one control reach every consumer, the `useSound` facet an add-on plays through
 * included. Four independent checks can disagree, and the one that gets forgotten is the
 * ring nobody can turn off.
 */
const ringerSilenced = derived(ringMode, ($mode) => $mode !== 'normal');

/** One ring's worth of steps, laid out against the moment playback starts. */
interface RingtoneStep {
  readonly freq: number;
  readonly at: number;
  readonly dur: number;
}

interface RingtoneChoice {
  readonly id: RingtoneId;
  readonly label: string;
  readonly wave: OscillatorType;
  /**
   * Peak gain as a fraction of the system volume. Per-tone, because a square wave at the
   * level a sine wants is painful.
   */
  readonly level: number;
  readonly steps: readonly RingtoneStep[];
}

/**
 * Five ringtones and not one audio file. MICA-62.
 *
 * The ticket put the fork plainly: synthesize more, or ship samples. This repo ships no
 * audio assets at all, and the reasons it does not are still true — a sample is weight in
 * a resource every player downloads, a licence to account for, and one more thing between
 * opening the phone and hearing it. A handful of oscillator sequences costs nothing, and
 * they are distinguishable from each other across a crowded scene, which is the actual
 * problem: telling your phone from the one next to you.
 *
 * They will all sound like a synthesizer. That is the trade, and it is the same one every
 * other sound in this file already made.
 *
 * `classic` is first and is the default because it is the two-note chime the phone has
 * always rung with — an upgrade must not change what somebody's phone already sounds like.
 */
const RINGTONE_CHOICES: readonly RingtoneChoice[] = [
  {
    id: 'classic',
    label: 'Classic',
    wave: 'sine',
    level: 0.25,
    steps: [
      { freq: 523.25, at: 0, dur: 0.08 },
      { freq: 659.25, at: 0.08, dur: 0.17 }
    ]
  },
  {
    id: 'chime',
    label: 'Chime',
    wave: 'triangle',
    level: 0.22,
    steps: [
      { freq: 659.25, at: 0, dur: 0.12 },
      { freq: 880.0, at: 0.12, dur: 0.12 },
      { freq: 1108.73, at: 0.24, dur: 0.3 }
    ]
  },
  {
    id: 'beacon',
    label: 'Beacon',
    wave: 'square',
    level: 0.1,
    steps: [
      { freq: 440.0, at: 0, dur: 0.12 },
      { freq: 440.0, at: 0.2, dur: 0.12 },
      { freq: 440.0, at: 0.44, dur: 0.2 }
    ]
  },
  {
    id: 'pulse',
    label: 'Pulse',
    wave: 'sawtooth',
    level: 0.08,
    steps: [
      { freq: 320.0, at: 0, dur: 0.09 },
      { freq: 320.0, at: 0.14, dur: 0.09 },
      { freq: 320.0, at: 0.28, dur: 0.09 },
      { freq: 320.0, at: 0.42, dur: 0.18 }
    ]
  },
  {
    id: 'ascent',
    label: 'Ascent',
    wave: 'sine',
    level: 0.24,
    steps: [
      { freq: 392.0, at: 0, dur: 0.1 },
      { freq: 493.88, at: 0.1, dur: 0.1 },
      { freq: 587.33, at: 0.2, dur: 0.1 },
      { freq: 783.99, at: 0.3, dur: 0.28 }
    ]
  }
];

const RINGTONE_BY_ID = new Map<RingtoneId, RingtoneChoice>(
  RINGTONE_CHOICES.map((choice) => [choice.id, choice])
);

/**
 * A stored choice is sanitized when it is read, which can be before `shell:ownerConfig` has
 * answered — so an `owner:` id is kept on shape alone (`shared/ownerConfig.ts`'s
 * `isRingtoneValue`, the same check the server holds a contact's column to) and resolved
 * when it plays. Checking it against the live list here would wipe the player's pick on
 * every cold start, and again whenever the owner briefly removes a file — a missing sound
 * plays the built-in default instead.
 */
const sanitizeRingtone = (value: unknown): RingtoneId =>
  isRingtoneValue(value) ? value : 'classic';

export const ringtone = usePersisted<RingtoneId>('settings', 'ringtone', 'classic', {
  sanitize: sanitizeRingtone
});

export const setRingtone = (id: RingtoneId) => ringtone.set(sanitizeRingtone(id));

/**
 * The list a picker renders, projected from the recipes above so the two cannot drift.
 *
 * Narrow on purpose: `wave`, `level` and the step table are how a tone is *made*, and a
 * published add-on that read them would be depending on a shape this file expects to
 * change every time a ringtone is retuned.
 */
export const RINGTONE_OPTIONS: readonly RingtoneOption[] = RINGTONE_CHOICES.map(
  ({ id, label }) => ({ id, label })
);

/** The notification chime the phone has always played; the one a notification tone falls back to. */
export const NOTIFICATION_TONE_DEFAULT = 'default';

const sanitizeNotificationTone = (value: unknown): string =>
  isOwnerSoundId(value) ? value : NOTIFICATION_TONE_DEFAULT;

/**
 * The chime for a notification, chosen apart from the ring. MICA-256.
 *
 * Built-in there is only the one chime, so the list is that plus whatever the owner ships.
 */
export const notificationTone = usePersisted<string>(
  'settings',
  'notificationTone',
  NOTIFICATION_TONE_DEFAULT,
  { sanitize: sanitizeNotificationTone }
);

export const setNotificationTone = (id: string) =>
  notificationTone.set(sanitizeNotificationTone(id));

const ownerOptions = (config: { sounds?: readonly { id: string; label: string }[] }) =>
  (config.sounds ?? []).map(({ id, label }) => ({ id, label }));

/** Built-in ringtones followed by the owner's sounds. Ids and labels only. */
export const ringtoneChoices = derived(ownerConfig, ($config): readonly RingtoneOption[] => [
  ...RINGTONE_OPTIONS,
  ...(ownerOptions($config) as unknown as RingtoneOption[])
]);

/**
 * The owner's notification sounds only — never a synthetic "Default" row. That entry is
 * a real UI string, not a shape this store owns; `Sound.svelte` prepends its own,
 * translated one, the same way `ContactDetails.svelte`'s ringtone picker prepends
 * "System default" rather than asking a shell-state module to carry `useLocale`.
 */
export const notificationToneChoices = derived(
  ownerConfig,
  ($config): readonly { readonly id: string; readonly label: string }[] => ownerOptions($config)
);

/**
 * `GetParentResourceName()`, the same lookup `nui/transport.ts` makes, with the same
 * `'mica'` fallback for a plain browser. Read fresh rather than cached at module load,
 * so a test can stub `window.GetParentResourceName` per call.
 */
const currentResourceName = (): string =>
  typeof window !== 'undefined' && window.GetParentResourceName
    ? window.GetParentResourceName()
    : 'mica';

/**
 * The URL an owner sound may be played from, or null. Only *this resource's* `cfx-nui`
 * origin is ever fetched — not merely something shaped like one, which would let a sound
 * id name any other resource on the same server and have this file `fetch` it — and a
 * root-relative path is the plain-browser mock's equivalent. A protocol-relative
 * `//host` or any other scheme is refused.
 */
export const ownerSoundUrl = (id: string): string | null => {
  const sound = get(ownerConfig).sounds?.find((entry) => entry.id === id);
  if (!sound) return null;
  const url = sound.url;
  if (url.startsWith(`https://cfx-nui-${currentResourceName()}/`)) return url;
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return url;
  console.warn(`Owner sound ${id} refused: not this resource's cfx-nui URL`);
  return null;
};

export const volumeHudVisible = writable<boolean>(false);

/**
 * How far one press of a physical volume button moves the volume, in whole percent.
 *
 * Configurable from Settings > Sound. Stored in percent rather than the store's 0–1
 * scale because that is the unit the setting is expressed in, and round-tripping
 * 5 → 0.05 → 5 through a float is a needless source of 4.999999.
 */
const VOLUME_STEP_KEY = 'volumeStep';

export const VOLUME_STEP_DEFAULT = 5;
export const VOLUME_STEP_CHOICES = [1, 2, 5, 10, 20] as const;

/** Reject a stored value that is not one of the offered steps. */
const sanitizeStep = (value: unknown): number =>
  (VOLUME_STEP_CHOICES as readonly number[]).includes(Number(value))
    ? Number(value)
    : VOLUME_STEP_DEFAULT;

/**
 * This was the hand-written read-at-init-plus-write-on-change that `usePersisted`
 * exists to absorb — it is now the hook's first consumer rather than its prototype.
 */
export const volumeStep = usePersisted<number>('settings', VOLUME_STEP_KEY, VOLUME_STEP_DEFAULT, {
  sanitize: sanitizeStep
});

export const setVolumeStep = (percent: number) => volumeStep.set(percent);

let hudTimeout: ReturnType<typeof setTimeout> | null = null;

export const soundVolumePercent = derived([soundVolume, soundMuted], ([$volume, $muted]) => {
  if ($muted) return 0;
  return Math.round(Math.max(0, Math.min(1, $volume)) * 100);
});

export const setVolume = (val: number) => {
  if (get(isBatteryDead)) return;
  const clamped = Math.max(0, Math.min(1, val));
  soundVolume.set(clamped);
  if (clamped === 0) {
    soundMuted.set(true);
  } else if (get(soundMuted)) {
    soundMuted.set(false);
  }
  showVolumeHud();
};

export const adjustVolume = (delta: number) => {
  if (get(isBatteryDead)) return;
  const current = get(soundVolume);
  const next = Math.max(0, Math.min(1, current + delta));
  setVolume(next);
  audio.play('click');
};

/**
 * One press of a physical volume button.
 *
 * Rounded to whole percent so a run of presses lands on 5, 10, 15 rather than drifting
 * off a float — the HUD shows whole percent, and 4.999999% renders as 5% while
 * behaving like 4.
 */
export const stepVolume = (direction: 1 | -1) => {
  if (get(isBatteryDead)) return;
  const currentPercent = Math.round(get(soundVolume) * 100);
  const nextPercent = Math.max(0, Math.min(100, currentPercent + direction * get(volumeStep)));
  setVolume(nextPercent / 100);
  audio.play('click');
};

export const toggleMute = () => {
  if (get(isBatteryDead)) return;
  soundMuted.update(($muted) => !$muted);
  showVolumeHud();
};

const showVolumeHud = () => {
  volumeHudVisible.set(true);
  if (hudTimeout) clearTimeout(hudTimeout);
  hudTimeout = setTimeout(() => {
    volumeHudVisible.set(false);
  }, 1500);
};

type OwnerKind = 'ring' | 'notify';

/** How long a fetch or decode failure is remembered before the next attempt may retry it. */
const OWNER_SOUND_RETRY_MS = 30_000;

class SoundService {
  private audioCtx: AudioContext | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  /** URL → the `Date.now()` a fetch or decode last failed at, so a retry is timed, not never. */
  private readonly failed = new Map<string, number>();
  private readonly playing = new Map<OwnerKind, AudioBufferSourceNode>();
  private warmingListenersAttached = false;
  /**
   * The most recently auditioned owner sound that is not also the selected ring or
   * notification tone — the one buffer `trimBuffers` keeps beyond those two, so tapping
   * through a whole list of choices does not cache every one of them at full PCM size.
   */
  private previewUrl: string | null = null;
  /**
   * Bumped by `stopRing`. A ring's cold-load `.then` captures the generation it started
   * under and checks it again before ever calling `start` — if the call has since ended,
   * the generation has moved and the tone must not begin at all, not even to fall back to
   * the built-in default (MICA-256 review: a decode that outlives the call must play
   * nothing, because "nothing" is the only state a call that already ended can be in).
   */
  private ringGeneration = 0;

  constructor() {
    // A stale failure must not survive an owner replacing the very file that failed;
    // trimBuffers' own picture of what merits keeping changes with it too.
    ownerConfig.subscribe(() => {
      this.failed.clear();
      this.trimBuffers();
    });
    ringtone.subscribe(() => this.trimBuffers());
    notificationTone.subscribe(() => this.trimBuffers());
  }

  /**
   * Every owner-sound buffer this session has any reason to hold: the selected ring and
   * notification tones, plus at most one more for whatever was last previewed. A decoded
   * buffer is the whole file in PCM — tens of MB is ordinary for a few seconds of audio —
   * so a cache keyed only by "have we ever fetched this" grows without bound across a
   * session that pages through Settings' picker or an add-on auditioning every choice
   * through `previewRingtone`.
   */
  private keepUrls(): ReadonlySet<string> {
    const keep = new Set<string>();
    for (const id of [get(ringtone), get(notificationTone)]) {
      if (!isOwnerSoundId(id)) continue;
      const url = ownerSoundUrl(id);
      if (url) keep.add(url);
    }
    if (this.previewUrl) keep.add(this.previewUrl);
    return keep;
  }

  private trimBuffers(): void {
    const keep = this.keepUrls();
    for (const url of this.buffers.keys()) {
      if (!keep.has(url)) this.buffers.delete(url);
    }
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  /**
   * Proactively warm and unlock the Web AudioContext on phone reveal or user gesture.
   * Prevents Chromium CEF autoplay restrictions from muting ringtones and notifications.
   *
   * Only attempted eagerly in CEF. A plain browser enforces Chrome's own autoplay policy
   * and refuses every time this runs before a real gesture — which in practice is always,
   * since `visible` starts `true` there — so the eager attempt did nothing but print a
   * console warning on every load. The `unlock` listeners below are what actually resume
   * it, on the player's first click, keypress or touch; skipping straight to attaching
   * them in a browser changes nothing about when audio actually unlocks.
   */
  public warm(): void {
    if (typeof window === 'undefined') return;
    if (!isBrowser()) {
      const ctx = this.getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    }

    if (this.warmingListenersAttached) return;
    this.warmingListenersAttached = true;

    void this.prefetch();

    const unlock = () => {
      const activeCtx = this.getAudioContext();
      if (activeCtx && activeCtx.state === 'suspended') {
        activeCtx.resume().catch(() => {});
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };

    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
  }

  /** Decode the chosen owner sounds ahead of the first ring, so it is not late. */
  public async prefetch(): Promise<void> {
    const ctx = this.getAudioContext();
    if (!ctx) return;
    for (const id of [get(ringtone), get(notificationTone)]) {
      if (!isOwnerSoundId(id)) continue;
      const url = ownerSoundUrl(id);
      if (url) await this.loadBuffer(ctx, url);
    }
  }

  /**
   * Fetch and decode an owner sound once. Null means it cannot be played, and stays null:
   * a bad file warns the first time and is not retried on every notification.
   */
  private loadBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached) return Promise.resolve(cached);
    const failedAt = this.failed.get(url);
    if (failedAt !== undefined && Date.now() - failedAt < OWNER_SOUND_RETRY_MS) {
      return Promise.resolve(null);
    }
    const inflight = this.pending.get(url);
    if (inflight) return inflight;
    const job = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(url, buffer);
        this.failed.delete(url);
        this.trimBuffers();
        return buffer;
      } catch (e) {
        console.warn(`Owner sound ${url} could not be played; using the built-in tone.`, e);
        this.failed.set(url, Date.now());
        return null;
      } finally {
        this.pending.delete(url);
      }
    })();
    this.pending.set(url, job);
    return job;
  }

  /**
   * Play an owner sound, or `fallback` — never nothing. An unknown id, a refused URL, a
   * failed fetch and an undecodable file all end in the built-in tone.
   */
  private playOwner(
    ctx: AudioContext,
    volume: number,
    id: string,
    kind: OwnerKind,
    fallback: () => void
  ): void {
    const url = ownerSoundUrl(id);
    if (!url) return fallback();
    // Only 'ring' needs to outlive the call it started for — a notification chime is
    // seconds long and never straddles an end-of-call race.
    const generation = this.ringGeneration;
    const start = (buffer: AudioBuffer) => {
      this.playing.get(kind)?.stop();
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        if (this.playing.get(kind) === source) this.playing.delete(kind);
      };
      this.playing.set(kind, source);
      source.start();
    };
    const cached = this.buffers.get(url);
    if (cached) {
      try {
        start(cached);
      } catch (e) {
        console.warn('Owner sound failed to start; using the built-in tone.', e);
        fallback();
      }
      return;
    }
    void this.loadBuffer(ctx, url).then((buffer) => {
      if (get(soundMuted)) return;
      // The call this ring was for has already ended (`stopRing` bumped the generation)
      // — starting now, built-in fallback included, would ring a call nobody is on.
      if (kind === 'ring' && generation !== this.ringGeneration) return;
      try {
        if (buffer) start(buffer);
        else fallback();
      } catch (e) {
        console.warn('Owner sound failed to start; using the built-in tone.', e);
        fallback();
      }
    });
  }

  /**
   * Stop whatever owner sound is ringing right now, and disarm any cold-load still in
   * flight for an earlier ring. Every call-toast end path calls this — accept, decline,
   * expire and a plain dismiss (`shell/state/toast.ts`) — because nothing else does: an
   * owner ringtone runs to the end of its own buffer otherwise, which for a multi-minute
   * file means a call answered thirty seconds ago is still audibly ringing.
   */
  public stopRing(): void {
    this.ringGeneration++;
    const source = this.playing.get('ring');
    if (!source) return;
    this.playing.delete('ring');
    try {
      source.stop();
    } catch {
      // Already stopped or already finished; either way there is nothing left to stop.
    }
  }

  public play(effect: SoundEffect, options?: { tone?: string | null }): void {
    if (get(soundMuted)) return;
    // The one gate. Every alerting sound in the phone reaches the speaker through here —
    // `toast.ts`'s four call sites and the `useSound` facet alike — so silencing it here
    // silences it everywhere, and no component has to know the mode exists.
    if (get(ringerSilenced) && ALERT_EFFECTS.has(effect)) return;
    const volume = get(soundVolume);
    const ctx = this.getAudioContext();
    if (!ctx) return;

    try {
      switch (effect) {
        case 'click':
          this.playClickSound(ctx, volume);
          break;
        case 'pop':
          this.playPopSound(ctx, volume);
          break;
        case 'camera':
          this.playCameraSound(ctx, volume);
          break;
        case 'notification': {
          const tone = get(notificationTone);
          if (isOwnerSoundId(tone)) {
            this.playOwner(ctx, volume, tone, 'notify', () =>
              this.playNotificationSound(ctx, volume)
            );
          } else {
            this.playNotificationSound(ctx, volume);
          }
          break;
        }
        case 'ringtone':
          this.playRingtoneId(ctx, volume, options?.tone || get(ringtone));
          break;
      }
    } catch (e) {
      console.error('Audio playback error:', e);
    }
  }

  private playClickSound(ctx: AudioContext, volume: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.03);
    gain.gain.setValueAtTime(volume * 0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);
  }

  private playPopSound(ctx: AudioContext, volume: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(volume * 0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  }

  private playCameraSound(ctx: AudioContext, volume: number) {
    const bufferSize = ctx.sampleRate * 0.05;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    whiteNoise.connect(gain);
    gain.connect(ctx.destination);
    whiteNoise.start();
  }

  /**
   * Play a ringtone because somebody tapped it in Settings, rather than because a call
   * arrived.
   *
   * Deliberately not routed through `play('ringtone')`: that would be silenced by the very
   * mode the player is sitting in the Sound pane to configure, and a preview button that
   * does nothing is worse than no preview button. It still answers to mute and to the
   * system volume, because those are statements about the speaker rather than about
   * whether the phone may interrupt you — which is how a real handset behaves when you
   * audition a tone with the switch flipped.
   */
  public preview(id: RingtoneId): void {
    if (get(soundMuted)) return;
    this.trackPreview(id);
    const ctx = this.getAudioContext();
    if (!ctx) return;

    try {
      this.playRingtoneId(ctx, get(soundVolume), id);
    } catch (e) {
      console.error('Audio playback error:', e);
    }
  }

  /** Audition a notification tone from Settings; answers to mute and volume, not the ringer. */
  public previewNotification(id: string): void {
    if (get(soundMuted)) return;
    this.trackPreview(id);
    const ctx = this.getAudioContext();
    if (!ctx) return;
    try {
      const fallback = () => this.playNotificationSound(ctx, get(soundVolume));
      if (isOwnerSoundId(id)) this.playOwner(ctx, get(soundVolume), id, 'notify', fallback);
      else fallback();
    } catch (e) {
      console.error('Audio playback error:', e);
    }
  }

  /**
   * Remember the one owner sound this session most recently auditioned, so its buffer is
   * the one `trimBuffers` keeps beyond the selected ring and notification tones — and evict
   * before the new one even starts loading, rather than waiting for it to land, so paging
   * through a whole list of choices never holds two previewed buffers at once.
   */
  private trackPreview(id: string): void {
    this.previewUrl = isOwnerSoundId(id) ? ownerSoundUrl(id) : null;
    this.trimBuffers();
  }

  /** A built-in pattern or an owner sound; an owner id that cannot play rings the default. */
  private playRingtoneId(ctx: AudioContext, volume: number, id: string) {
    if (isOwnerSoundId(id)) {
      this.playOwner(ctx, volume, id, 'ring', () => this.playRingtone(ctx, volume, 'classic'));
      return;
    }
    this.playRingtone(ctx, volume, id);
  }

  /**
   * One oscillator and one gain envelope per note, scheduled against `currentTime`.
   *
   * The short ramp up to peak is an attack rather than decoration: starting a gain at its
   * full value produces an audible click at the top of every note, and five tones built
   * out of a dozen notes between them would click a dozen times. `exponentialRampToValue`
   * cannot reach or leave zero, hence the near-silent floor either side.
   */
  private playRingtone(ctx: AudioContext, volume: number, id: RingtoneId) {
    const tone = RINGTONE_BY_ID.get(id) ?? RINGTONE_CHOICES[0];
    const now = ctx.currentTime;
    const FLOOR = 0.0001;

    for (const step of tone.steps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + step.at;
      const end = start + step.dur;

      osc.type = tone.wave;
      osc.frequency.setValueAtTime(step.freq, start);

      gain.gain.setValueAtTime(FLOOR, start);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(FLOOR, volume * tone.level),
        Math.min(start + 0.01, end)
      );
      gain.gain.exponentialRampToValueAtTime(FLOOR, end);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end);
    }
  }

  private playNotificationSound(ctx: AudioContext, volume: number) {
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc2.frequency.setValueAtTime(659.25, now + 0.08); // E5

    gain.gain.setValueAtTime(volume * 0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.08);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.25);
  }
}

export const audio = new SoundService();
