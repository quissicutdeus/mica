// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // Highscores — shared leaderboard. Stateless mock: `pnpm dev` cannot stand in for a real
  // server per docs/writing-an-app.md, so this is just enough to exercise the UI.
  'highscores:submit': async () => ({ ok: true }),
  'highscores:top': async () => [
    { citizenid: 'MOCK1', score: 42, displayName: 'Ada' },
    { citizenid: 'MOCK2', score: 17, displayName: 'Dez' }
  ]
};
