// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from 'node:crypto';
import { db } from './db';

/**
 * The token micaOS prints in a log line for a citizenid or a number (MICA-433, `who()` in
 * `server/lib/who.ts`), computed here the way the server computes it, so a scenario waits for
 * the exact line about its own fixture rather than for any line at all.
 *
 * Written from the documented shape, not imported, as `sealed.ts` is: HMAC-SHA-256 under the
 * install's salt, the first ten hex characters. The salt is the first `log-salt:<64 hex>` row
 * of `mica_schema_migrations` by `applied_at`, then by id — the row every server on the database
 * agrees on. `server/__tests__/integrationLogToken.test.ts` holds this to the real `who()`.
 */
const SALT_SHAPE = /^log-salt:([0-9a-f]{64})$/;
const TOKEN_HEX = 10;

/** The token for `value` under a salt given as its 64 hex characters. */
export const tokenUnder = (saltHex: string, value: string): string =>
  createHmac(
    'sha256',
    Uint8Array.from({ length: saltHex.length / 2 }, (_, i) =>
      Number.parseInt(saltHex.slice(i * 2, i * 2 + 2), 16)
    )
  )
    .update(value.trim())
    .digest()
    .toString('hex')
    .slice(0, TOKEN_HEX);

/**
 * The install's salt, read as the server reads it. Throws when there is none: the server is
 * then printing per-process `~` tokens, which no scenario can match, and that is the failure.
 */
export const installSaltHex = async (): Promise<string> => {
  const rows = await db.rows(
    'SELECT `id` FROM `mica_schema_migrations` WHERE `id` LIKE ? ORDER BY `applied_at`, `id`',
    ['log-salt:%']
  );
  for (const row of rows) {
    const match = SALT_SHAPE.exec(String(row.id));
    if (match) return match[1];
  }
  throw new Error('no log-salt row in mica_schema_migrations: micaOS never minted its log salt');
};

/** The token micaOS prints for `value` on this install. */
export const serverWho = async (value: string): Promise<string> =>
  tokenUnder(await installSaltHex(), value);
