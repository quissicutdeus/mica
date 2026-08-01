import { writable, derived, get } from 'svelte/store';
import { useStorage } from '../sdk/hooks/useStorage';

export type SoundEffect = 'click' | 'pop' | 'camera' | 'notification' | 'ringtone';

export const soundVolume = writable<number>(0.5);
export const soundMuted = writable<boolean>(false);
export const volumeHudVisible = writable<boolean>(false);

/**
 * How far one press of a physical volume button moves the volume, in whole percent.
 *
 * Configurable from Settings > Sound. Stored in percent rather than the store's 0–1
 * scale because that is the unit the setting is expressed in, and round-tripping
 * 5 → 0.05 → 5 through a float is a needless source of 4.999999.
 */
const storage = useStorage('settings');
const VOLUME_STEP_KEY = 'volumeStep';

export const VOLUME_STEP_DEFAULT = 5;
export const VOLUME_STEP_CHOICES = [1, 2, 5, 10, 20] as const;

/** Reject a stored value that is not one of the offered steps. */
const sanitizeStep = (value: unknown): number =>
  (VOLUME_STEP_CHOICES as readonly number[]).includes(Number(value))
    ? Number(value)
    : VOLUME_STEP_DEFAULT;

export const volumeStep = writable<number>(
  sanitizeStep(storage.getItem<number>(VOLUME_STEP_KEY, VOLUME_STEP_DEFAULT))
);

export const setVolumeStep = (percent: number) => {
  const next = sanitizeStep(percent);
  volumeStep.set(next);
  storage.setItem(VOLUME_STEP_KEY, next);
};

let hudTimeout: ReturnType<typeof setTimeout> | null = null;

export const soundVolumePercent = derived([soundVolume, soundMuted], ([$volume, $muted]) => {
  if ($muted) return 0;
  return Math.round(Math.max(0, Math.min(1, $volume)) * 100);
});

export const setVolume = (val: number) => {
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
  const current = get(soundVolume);
  const next = Math.max(0, Math.min(1, current + delta));
  setVolume(next);
  soundService.play('click');
};

/**
 * One press of a physical volume button.
 *
 * Rounded to whole percent so a run of presses lands on 5, 10, 15 rather than drifting
 * off a float — the HUD shows whole percent, and 4.999999% renders as 5% while
 * behaving like 4.
 */
export const stepVolume = (direction: 1 | -1) => {
  const currentPercent = Math.round(get(soundVolume) * 100);
  const nextPercent = Math.max(0, Math.min(100, currentPercent + direction * get(volumeStep)));
  setVolume(nextPercent / 100);
  soundService.play('click');
};

export const toggleMute = () => {
  soundMuted.update(($muted) => !$muted);
  showVolumeHud();
};

export const showVolumeHud = () => {
  volumeHudVisible.set(true);
  if (hudTimeout) clearTimeout(hudTimeout);
  hudTimeout = setTimeout(() => {
    volumeHudVisible.set(false);
  }, 1500);
};

class SoundService {
  private audioCtx: AudioContext | null = null;

  private getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  public play(effect: SoundEffect): void {
    if (get(soundMuted)) return;
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
          this.playNotificationSound(ctx, volume);
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

export const soundService = new SoundService();
