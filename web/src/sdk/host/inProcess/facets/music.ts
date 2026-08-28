import { registerFacet } from '../../current';
import {
  musicSource,
  musicStatus,
  musicVolume,
  playSource,
  pauseMusic,
  resumeMusic,
  stopMusic,
  setMusicVolume,
  type MusicSource,
  type MusicStatus
} from '../../../../shell/state/music';
import { isYouTubeSource } from '@shared/youtube';

export type { MusicSource, MusicStatus };

/**
 * Implementation of the `useMusic` facet — see the `useMusic` hook doc for the contract.
 *
 * Deliberately no `embedUrlFor`, no `playerCommand` and no `reportPlayerState`. Those are
 * the shell's conversation with the embed; an app that could build a `src` or post a
 * command to the frame would be an app that could point the player at a URL of its own,
 * which is exactly what `shared/youtube.ts` exists to prevent. The app gets an intent and
 * a status, and the shell decides what that means.
 */
export function music() {
  return {
    /** What is loaded, as ids. `null` when nothing is. */
    musicSource,
    /** What the phone has been asked to do with it. */
    musicStatus,
    /** Music's own volume, 0–1 — not the phone's UI-sound volume. */
    musicVolume,
    /**
     * Is this string a YouTube video or playlist link? Pure, synchronous, and answered
     * locally on both sides of the add-on seam — ask this before `playSource` so the app
     * can report a bad paste in its own words.
     */
    canPlay: isYouTubeSource,
    /** Load and start it. Silently drops anything `canPlay` would have refused. */
    playSource,
    pauseMusic,
    resumeMusic,
    stopMusic,
    setMusicVolume
  };
}

registerFacet('music', music);
