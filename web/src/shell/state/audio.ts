import { writable, derived, get } from 'svelte/store';
import { usePersisted } from '../../sdk/host/usePersisted';
import { isBatteryDead } from './charge';
import { isBrowser } from '../../lib/isBrowser';

export type SoundEffect = 'click' | 'pop' | 'camera' | 'notification' | 'ringtone';

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
export type RingMode = 'normal' | 'vibrate' | 'silent';

export interface RingModeChoice {
  readonly id: RingMode;
  readonly label: string;
  /** Shown under the label in Settings > Sound. Says what the mode actually does. */
  readonly description: string;
}

/**
 * **Vibrate is honest about being a label, for now.**
 *
 * There is no haptic device on the other side of this: gPhone renders in FiveM's CEF on a
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

export type RingtoneId = 'classic' | 'chime' | 'beacon' | 'pulse' | 'ascent';

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

const sanitizeRingtone = (value: unknown): RingtoneId =>
  RINGTONE_BY_ID.has(value as RingtoneId) ? (value as RingtoneId) : 'classic';

export const ringtone = usePersisted<RingtoneId>('settings', 'ringtone', 'classic', {
  sanitize: sanitizeRingtone
});

export const setRingtone = (id: RingtoneId) => ringtone.set(sanitizeRingtone(id));

/** What a chooser needs, and nothing behind it. */
export interface RingtoneOption {
  readonly id: RingtoneId;
  readonly label: string;
}

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

class SoundService {
  private audioCtx: AudioContext | null = null;
  private warmingListenersAttached = false;

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

  public play(effect: SoundEffect): void {
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
        case 'notification':
          this.playNotificationSound(ctx, volume);
          break;
        case 'ringtone':
          this.playRingtone(ctx, volume, get(ringtone));
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
    const ctx = this.getAudioContext();
    if (!ctx) return;

    try {
      this.playRingtone(ctx, get(soundVolume), id);
    } catch (e) {
      console.error('Audio playback error:', e);
    }
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
