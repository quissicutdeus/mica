// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseRetentionDays } from '../contentRetention';
import { imageHost, uploadConfig } from '../mediaHost';
import { quotaBytes } from './quota';
import { formatBytes } from './stats';

/**
 * How many days of media are kept, or `0` for forever: `mica_media_retention`, **365 by
 * default** since MICA-167.
 *
 * This was off by default until then, on the argument that it is the one thing here that
 * destroys a photo a player still expects to have. MICA-167 decided that no player content is
 * kept forever by default, and a year is the answer to both concerns: long enough that no
 * active player loses a photo they are still using — a gallery a year old is an archive — and
 * finite, so the heaviest table micaOS has (base64 in `mediumtext`) stops growing on a server
 * whose players left. Longer than messages because a photo is the thing a player kept on
 * purpose. `0` (or `off`) restores the old keep-forever behaviour; a typo lands on the default
 * and is logged, never on forever — which is why this reads `GetConvar` and not
 * `GetConvarInt`, which answers `0` for anything it cannot parse.
 *
 * The quota (`quota.ts`) is what bounds ordinary growth without deleting anything; retention is what
 * bounds the rest.
 */
export const retentionDays = (): number =>
  parseRetentionDays(GetConvar('mica_media_retention', ''), 365, 'mica_media_retention');

/**
 * Say what the limits actually resolved to, once, at resource start.
 *
 * A quota that a typo turned off is the failure this line exists to make loud. Both knobs
 * fall back rather than throw — the right behaviour for something that would otherwise
 * refuse every photo on the server — and a fallback nobody is told about is a setting an
 * owner believes is in force.
 *
 * (Both convar names are written as literals at their `GetConvarInt` call site rather than
 * hoisted into a `const`. That is what `convars.test.ts` reads to check the name is
 * documented in the README, and a literal is the form it resolves without guessing.)
 */
export const logMediaLimits = (): void => {
  const limit = quotaBytes();
  const days = retentionDays();
  // Where a new photo goes (MICA-243). Only the host name: the upload header is a secret.
  const upload = uploadConfig();
  const host = imageHost();
  const storage = upload
    ? `photos uploaded to ${upload.host}`
    : host
      ? `photos in the database, earlier hosted photos drawn from ${host}`
      : 'photos in the database';
  console.log(
    `[micamedia] per-player quota ${limit > 0 ? formatBytes(limit) : 'off'}, ` +
      `retention ${days > 0 ? `${days} day(s)` : 'off'}, ${storage}.`
  );
};
