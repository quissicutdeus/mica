import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';
import { isYouTubeSource, thumbnailUrlFor } from '@shared/youtube';
import { describeMusicError } from '../../../lib/musicErrors';
import { MAX_AUDIBLE_BROADCASTS } from '../../../lib/musicBroadcast';

type Twin = AsTwin<ReturnType<Facets['music']>>;

/**
 * Implementation of the `useMusic` facet for a sandboxed add-on — see the inProcess twin
 * for the usage contract.
 *
 * `canPlay`, `thumbnailUrlFor` and `describeMusicError` are imported and run locally
 * rather than sent over the wire, the way `theme`'s `sanitizeSeed` is: `shared/youtube.ts`
 * and `lib/musicErrors.ts` are pure and do no I/O, so they bundle into the sandbox
 * unchanged and stay synchronous. That is the whole reason
 * `playSource` reports nothing back — over this transport it could only ever answer with a
 * promise, so the "is this a link" question is answered before the call rather than by it,
 * and a thumbnail an app has to `await` is a thumbnail that arrives after the row is drawn.
 *
 * The stores are read-only here, as everywhere across this seam: an add-on watches what is
 * playing and asks for changes, and the shell decides.
 */
export function music(): Twin {
  return {
    musicSource: store('music', [], 'musicSource', null),
    musicStatus: store('music', [], 'musicStatus', 'idle'),
    musicVolume: store('music', [], 'musicVolume', 0.5),
    musicMuted: store('music', [], 'musicMuted', false),
    musicQueue: store('music', [], 'musicQueue', []),
    musicIndex: store('music', [], 'musicIndex', -1),
    musicNowPlaying: store('music', [], 'musicNowPlaying', null),
    musicError: store('music', [], 'musicError', null),
    musicPosition: store('music', [], 'musicPosition', { current: 0, duration: 0 }),
    musicRepeat: store('music', [], 'musicRepeat', 'off'),
    musicShuffle: store('music', [], 'musicShuffle', false),
    musicHasNext: store('music', [], 'musicHasNext', false),
    musicHasPrevious: store('music', [], 'musicHasPrevious', false),
    canPlay: isYouTubeSource,
    thumbnailUrlFor,
    describeMusicError,
    playSource: fn('music', [], 'playSource'),
    enqueue: fn('music', [], 'enqueue'),
    playQueueIndex: fn('music', [], 'playQueueIndex'),
    removeFromQueue: fn('music', [], 'removeFromQueue'),
    clearQueue: fn('music', [], 'clearQueue'),
    nextTrack: fn('music', [], 'nextTrack'),
    previousTrack: fn('music', [], 'previousTrack'),
    seekMusic: fn('music', [], 'seekMusic'),
    cycleRepeat: fn('music', [], 'cycleRepeat'),
    setRepeat: fn('music', [], 'setRepeat'),
    toggleShuffle: fn('music', [], 'toggleShuffle'),
    pauseMusic: fn('music', [], 'pauseMusic'),
    resumeMusic: fn('music', [], 'resumeMusic'),
    stopMusic: fn('music', [], 'stopMusic'),
    setMusicVolume: fn('music', [], 'setMusicVolume'),
    setMusicMuted: fn('music', [], 'setMusicMuted'),
    toggleMusicMute: fn('music', [], 'toggleMusicMute'),

    // Nearby music (MICA-111 phase 2). `maxAudibleBroadcasts` is imported and read
    // locally rather than sent over the wire, for the same reason `canPlay` is: it is a
    // constant in a pure module, so it bundles into the sandbox unchanged and a screen can
    // put the number in a sentence without awaiting anything.
    nearbyBroadcasts: store('music', [], 'nearbyBroadcasts', []),
    audibleBroadcasts: store('music', [], 'audibleBroadcasts', []),
    maxAudibleBroadcasts: MAX_AUDIBLE_BROADCASTS,
    mutedBroadcasters: store('music', [], 'mutedBroadcasters', []),
    muteAllNearby: store('music', [], 'muteAllNearby', false),
    muteBroadcaster: fn('music', [], 'muteBroadcaster'),
    unmuteBroadcaster: fn('music', [], 'unmuteBroadcaster'),
    toggleBroadcasterMute: fn('music', [], 'toggleBroadcasterMute'),
    clearMutedBroadcasters: fn('music', [], 'clearMutedBroadcasters'),
    setMuteAllNearby: fn('music', [], 'setMuteAllNearby'),
    toggleMuteAllNearby: fn('music', [], 'toggleMuteAllNearby')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and async where the wire makes something inProcess exposes synchronously. This
// is the one place that gap is bridged, once per facet, rather than a blanket cast hiding
// the whole object from the checker.
registerFacet('music', music as unknown as Facets['music']);
