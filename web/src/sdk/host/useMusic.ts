import './inProcess/facets/music';
import { guarded } from './guard';

/**
 * Control the phone's music playback (MICA-111).
 *
 * The player itself is the shell's, mounted outside everything the phone's close tears
 * down, so an app that opens and closes cannot interrupt a track. What this hands over is
 * the intent — what to load, and whether it should be running — plus the status to render
 * from. There is no handle on the underlying element by design; see
 * `inProcess/facets/music.ts` for what is withheld and why.
 *
 * `playSource` takes whatever a person pasted and reduces it to a YouTube video or
 * playlist id before anything is stored. It returns `false` when there is no id in there,
 * so an app can say so rather than silently doing nothing.
 *
 * **Phase 1 is local playback: the person hears their own music and nobody else does.**
 * There is no proximity broadcast behind this yet, and an app should not imply one.
 */
export function useMusic() {
  return guarded('useMusic').facets.music();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
export type { MusicSource, MusicStatus } from './inProcess/facets/music';
