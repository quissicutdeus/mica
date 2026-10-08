// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PRIVACY_DELETE_CONFIRMATION } from '@mica/shared/contracts/privacy';
import type { MockHandler } from '../registry';

let mockPrivacyDeleted = false;
const PRIVACY_EXPORT_LIMIT = 3;
const PRIVACY_EXPORT_WINDOW_MS = 60_000;
let mockPrivacyExports: number[] = [];

export const mocks: Record<string, MockHandler> = {
  // Your data (MICA-168). Stateful, like the report mock: deleting has to empty the export,
  // or the pane's "nothing held" state and the refreshed list are unreachable in a browser.
  // The word is checked here as the server checks it, so a wrong one is a refusal the pane
  // shows, not something the UI decided. Two rows stay behind, as they do for content under
  // an open report, so the result's `kept` is not always zero.
  'privacy:export': async () => {
    // The server limits export to three a minute. Enforced here the same way, so a spec
    // sees the refusal the game gives instead of a mock that always answers.
    const now = Date.now();
    mockPrivacyExports = mockPrivacyExports.filter((at) => now - at < PRIVACY_EXPORT_WINDOW_MS);
    if (mockPrivacyExports.length >= PRIVACY_EXPORT_LIMIT) {
      const wait = Math.ceil((mockPrivacyExports[0] + PRIVACY_EXPORT_WINDOW_MS - now) / 1000);
      // The shape and key `server/services/Privacy.ts` sends; `fetchNui` translates it through
      // the shell's server catalog, so the pane shows the real wording. The text here is the
      // fallback a catalog without the key would give.
      return {
        error: `You can export your data ${PRIVACY_EXPORT_LIMIT} times a minute. Try again in ${wait}s.`,
        key: 'server.privacy.exportTooSoon',
        params: { seconds: wait }
      };
    }
    mockPrivacyExports.push(now);
    return {
      generatedAt: '2026-09-28T12:00:00.000Z',
      limitChars: 200000,
      truncated: !mockPrivacyDeleted,
      categories: mockPrivacyDeleted
        ? []
        : [
            {
              category: 'notes',
              rows: [
                { id: 1, title: 'Groceries', content: 'Eggs, milk, coffee' },
                { id: 2, title: 'Pin codes', content: 'Locker 4471' }
              ],
              truncated: false,
              withheld: []
            },
            {
              category: 'messages',
              rows: Array.from({ length: 25 }, (_, i) => ({
                id: i + 1,
                conversation_id: 3,
                message: `Message ${i + 1}`
              })),
              truncated: 'rows',
              withheld: []
            },
            {
              category: 'media',
              rows: [{ id: 7, kind: 'photo', data_bytes: 184220 }],
              truncated: false,
              withheld: ['owner_token']
            },
            // Cut for the whole export's size budget: no rows at all, and it must still be
            // listed rather than read as an empty category.
            { category: 'marketplace_attachments', rows: [], truncated: 'size', withheld: [] }
          ]
    };
  },
  'privacy:delete': async (data?: { confirm?: string }) => {
    if (data?.confirm !== PRIVACY_DELETE_CONFIRMATION) {
      return {
        error: `That is not the confirmation word. Type ${PRIVACY_DELETE_CONFIRMATION} exactly.`
      };
    }
    mockPrivacyDeleted = true;
    return { complete: true, removed: 28, kept: 2, failed: [] };
  }
};
