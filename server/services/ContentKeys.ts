// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DEFAULT_BATCH,
  MAX_BATCH,
  NoActiveKeyError,
  formatBackfill,
  formatStatus,
  walkContent,
  type NotificationScope
} from '../lib/contentBackfill';
import { KeyringError, loadedKeyIds, writeNewKeyFile } from '../lib/contentCipher';
import { notifyPlayer } from '../lib/shell';

/**
 * `micacrypt` (MICA-165): the console's view of content encryption, the backfill that seals
 * what was stored before a key existed, and the command that writes a first key.
 *
 * **Console only, the gate `micaimport` carries.** `backfill --apply` rewrites every player's
 * message, DM and mail bodies, and `keygen` writes a file on the server's disk; `status` is
 * gated with them so the command has one rule and an admin cannot read the shape of other
 * players' content through its counts.
 */

/**
 * The persisted DM notifications whose body a push wrote before MICA-165 made new ones `''`.
 * Named here, not in `lib/contentBackfill.ts`: core may not name an add-on's app id, and this
 * file is a service.
 */
const DM_NOTIFICATIONS: NotificationScope = { app: 'blabber', kind: 'dm' };

export const USAGE = [
  '[micacrypt] usage:',
  '[micacrypt]   micacrypt status',
  `[micacrypt]   micacrypt backfill [--apply] [--batch N]   (N from 1 to ${MAX_BATCH}, default ${DEFAULT_BATCH})`,
  '[micacrypt]   micacrypt keygen <absolute path> [kid]'
];

let running = false;

const say = (line: string): void => console.log(line);

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `k<YYYYMMDD>-<HHMM>`, UTC: fourteen characters, inside the id pattern, and different for a
 * second keygen the same day — a keyring naming one id twice is refused whole.
 */
export const defaultKid = (now: Date): string =>
  `k${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-` +
  `${two(now.getUTCHours())}${two(now.getUTCMinutes())}`;

const parseBackfill = (args: string[]): { apply: boolean; batch: number } | null => {
  let apply = false;
  let batch = DEFAULT_BATCH;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i].toLowerCase();
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--batch') {
      const value = args[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) return null;
      batch = Number(value);
      if (batch < 1 || batch > MAX_BATCH) return null;
      i += 1;
    } else {
      return null;
    }
  }
  return { apply, batch };
};

const runKeygen = (args: string[]): void => {
  const path = args[0];
  if (!path || args.length > 2) {
    for (const line of USAGE) say(line);
    return;
  }
  const kid = args[1] ?? defaultKid(new Date());
  // The new line goes into the live key file beside these, and a keyring that names one id
  // twice is refused whole — every body sealed with any of its keys would stop opening.
  if (loadedKeyIds().includes(kid)) {
    console.error(
      `[micacrypt] keygen refused: the key id '${kid}' is already in the loaded key file; ` +
        'give the new key another id.'
    );
    return;
  }
  try {
    const written = writeNewKeyFile(path, kid);
    say(`[micacrypt] wrote a new key '${kid}' to ${written.path} (mode 600).`);
    say('[micacrypt] to turn encryption on, add this to server.cfg and restart the resource:');
    say(`[micacrypt]   set mica_content_key_file "${written.path}"`);
    say('[micacrypt] use set, never setr: setr would send the path to every client.');
    say(
      '[micacrypt] keep the file outside server-data, outside the database backup and out of ' +
        'git, and back it up somewhere else: losing it loses every body sealed with it.'
    );
    say(
      '[micacrypt] to rotate instead, put its key line first in the live key file, keep the ' +
        'old lines after it, restart, then run micacrypt backfill --apply.'
    );
    if (written.warnings.length > 0) {
      say(`[micacrypt] ${written.warnings.length} warning(s) about where the file is, above.`);
    }
  } catch (error) {
    if (error instanceof KeyringError) {
      console.error(`[micacrypt] keygen refused: ${error.message}`);
      return;
    }
    throw error;
  }
};

/**
 * `micacrypt <status | backfill [--apply] [--batch N] | keygen <absolute path> [kid]>`.
 * One run at a time: two backfills racing would each count the other's writes as misses.
 */
export const runContentKeysCommand = async (source: number, args: string[]): Promise<void> => {
  if (source !== 0) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.schema.noPermission'
    });
    return;
  }

  const words = (args ?? []).map((arg) => String(arg));
  const sub = (words[0] ?? '').toLowerCase();
  const rest = words.slice(1);

  if (sub === 'keygen') {
    runKeygen(rest);
    return;
  }

  let backfill: { apply: boolean; batch: number } | null = null;
  if (sub === 'backfill') {
    backfill = parseBackfill(rest);
    if (backfill === null) {
      for (const line of USAGE) say(line);
      return;
    }
  } else if (sub !== 'status' || rest.length > 0) {
    for (const line of USAGE) say(line);
    return;
  }

  if (running) {
    say('[micacrypt] a status or backfill is already running; wait for it to finish.');
    return;
  }
  running = true;
  try {
    if (backfill === null) {
      const report = await walkContent({ apply: false, notifications: DM_NOTIFICATIONS });
      for (const line of formatStatus(report)) say(line);
    } else {
      const report = await walkContent({
        apply: backfill.apply,
        batch: backfill.batch,
        notifications: DM_NOTIFICATIONS
      });
      for (const line of formatBackfill(report)) say(line);
    }
  } catch (error) {
    if (error instanceof NoActiveKeyError) {
      console.error(`[micacrypt] backfill --apply refused: ${error.message}`);
      return;
    }
    console.error(
      `[micacrypt] ${sub} failed part-way; every value already written is sealed and a re-run ` +
        'continues from what is left:',
      error
    );
  } finally {
    running = false;
  }
};

RegisterCommand(
  'micacrypt',
  (source: number, args: string[]) => {
    void runContentKeysCommand(source, args);
  },
  false
);
