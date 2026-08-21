import { audio, type SoundEffect } from '../../shell/state/audio';

/**
 * The phone's sound effects.
 *
 * `SoundService` has been complete and unit-tested since the shell existed — volume- and
 * mute-aware, used by `AppIcon`, `ToggleSwitch` and `SegmentedControl`. It was simply
 * never exported, so the only route to it was `../../shell/state/audio`, which
 * `boundary.test.ts` rejects. An app had no sanctioned way to make a noise.
 *
 * That is the `SegmentedControl` failure mode again: written, working, left out of the
 * barrel. The volume *controls* live in `useSystemHardware` — this is playback.
 */
export function useSound() {
  return {
    /** Play one of the phone's built-in effects. Silent while muted. */
    play: (effect: SoundEffect) => audio.play(effect)
  };
}
