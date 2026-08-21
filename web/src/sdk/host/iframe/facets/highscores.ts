import { registerFacet } from '../../current';
import { fn } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/highscores').highscores>;

export function highscores(): Twin {
  return {
    submitScore: fn('highscores', [], 'submitScore'),
    getLeaderboard: fn('highscores', [], 'getLeaderboard')
  } as unknown as Twin;
}
registerFacet('highscores', highscores);
