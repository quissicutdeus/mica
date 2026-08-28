import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';
import { isYouTubeSource } from '@shared/youtube';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/music').music>>;

/**
 * Implementation of the `useMusic` facet for a sandboxed add-on — see the inProcess twin
 * for the usage contract.
 *
 * `canPlay` is imported and run locally rather than sent over the wire, the way `theme`'s
 * `sanitizeSeed` is: `shared/youtube.ts` is pure and does no I/O, so it bundles into the
 * sandbox unchanged and stays synchronous. That is the whole reason `playSource` reports
 * nothing back — over this transport it could only ever answer with a promise, so the
 * "is this a link" question is answered before the call rather than by it.
 *
 * The stores are read-only here, as everywhere across this seam: an add-on watches what is
 * playing and asks for changes, and the shell decides.
 */
export function music(): Twin {
  return {
    musicSource: store('music', [], 'musicSource', null),
    musicStatus: store('music', [], 'musicStatus', 'idle'),
    musicVolume: store('music', [], 'musicVolume', 0.5),
    canPlay: isYouTubeSource,
    playSource: fn('music', [], 'playSource'),
    pauseMusic: fn('music', [], 'pauseMusic'),
    resumeMusic: fn('music', [], 'resumeMusic'),
    stopMusic: fn('music', [], 'stopMusic'),
    setMusicVolume: fn('music', [], 'setMusicVolume')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and async where the wire makes something inProcess exposes synchronously. This
// is the one place that gap is bridged, once per facet, rather than a blanket cast hiding
// the whole object from the checker.
registerFacet('music', music as unknown as Facets['music']);
