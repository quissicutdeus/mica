import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/highscores').highscores>>;

export function highscores(): Twin {
  return {
    submitScore: fn('highscores', [], 'submitScore'),
    getLeaderboard: fn('highscores', [], 'getLeaderboard')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('highscores', highscores as unknown as Facets['highscores']);
