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
import {
  KEY_RESOURCE,
  isKeyId,
  loadedKeyIds,
  serverDataDir,
  suggestedKeyFile
} from '../lib/contentCipher';
import { notifyPlayer } from '../lib/shell';

/**
 * `micacrypt` (MICA-165): the console's view of content encryption, the backfill that seals
 * what was stored before a key existed, and the steps that set a key up.
 *
 * **Console only, the gate `micaimport` carries.** `backfill --apply` rewrites every player's
 * message, DM and mail bodies; `status` and `keygen` are gated with it so the command has one
 * rule and an admin cannot read the shape of other players' content through its counts.
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
  '[micacrypt]   micacrypt keygen [kid]'
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

/** Two lines are a whole resource: FXServer needs only to see a manifest to call it one. */
const KEY_MANIFEST = ["fx_version 'cerulean'", "game 'common'"];

/**
 * What `micacrypt keygen` prints: the steps that set a content key up (MICA-303).
 *
 * **It writes nothing and prints no key.** FXServer lets a resource write only into its own
 * folder — never into another resource's, never outside resources — and micaOS's own folder is
 * the one place a key must not live, because an update replaces it. And the console is logged,
 * so a key printed there would sit in every log beside the database it protects. So the key is
 * made by the owner's shell, straight into a file only they can read, and this says how.
 *
 * `set -C` makes the shell refuse to overwrite a file that is already there: a key overwritten
 * is every body sealed with it gone, and that promise was keygen's before it stopped writing.
 */
export const keygenSteps = (kid: string, serverData: string | null): string[] => {
  const root = serverData ?? '<server-data>';
  const file = suggestedKeyFile(root);
  const dir = file.slice(0, file.lastIndexOf('/'));
  return [
    '[micacrypt] keygen writes no file and prints no key: FXServer lets micaOS write nowhere a ' +
      'key belongs, and this console is logged.',
    `[micacrypt] to turn content encryption on with a new key '${kid}', from a shell on the server:`,
    `[micacrypt] 1. make a resource of its own for the key, ${KEY_RESOURCE} (never inside mica, ` +
      'which an update replaces):',
    `[micacrypt]      mkdir -p "${dir}"`,
    '[micacrypt]    and in it an fxmanifest.lua of these two lines:',
    ...KEY_MANIFEST.map((line) => `[micacrypt]      ${line}`),
    '[micacrypt] 2. write the key there, readable only by you (it refuses to overwrite a file):',
    `[micacrypt]      (umask 077; set -C; printf '%s %s\\n' "${kid}" "$(openssl rand -base64 32)" ` +
      `> "${file}")`,
    '[micacrypt]    better: write it outside server-data instead and put a symlink to it at that ' +
      'path, so a backup of server-data does not carry it.',
    '[micacrypt] 3. add this to server.cfg (set, never setr: setr would send the path to every ' +
      'client):',
    `[micacrypt]      set mica_content_key_file "${file}"`,
    `[micacrypt]    those paths take server-data to be ${root}; adjust if your resources live ` +
      'elsewhere.',
    '[micacrypt] 4. restart the server, then run: micacrypt backfill --apply',
    '[micacrypt] back the key up away from the database: losing it loses every body sealed ' +
      'with it.',
    "[micacrypt] to rotate instead, make the new key's line with step 2 in another file, put it " +
      'first in the live key file with the old lines after it, restart, then run micacrypt ' +
      'backfill --apply.'
  ];
};

const runKeygen = (args: string[]): void => {
  if (args.length > 1) {
    for (const line of USAGE) say(line);
    return;
  }
  const kid = args[0] ?? defaultKid(new Date());
  if (!isKeyId(kid)) {
    console.error(
      `[micacrypt] keygen refused: the key id '${kid}' is not 1-16 of a-z, 0-9 and '-'.` +
        (/[/\\]/.test(kid) ? ' keygen takes no path: it writes nothing, and prints the steps.' : '')
    );
    return;
  }
  // The new line goes into the live key file beside these, and a keyring that names one id
  // twice is refused whole — every body sealed with any of its keys would stop opening.
  if (loadedKeyIds().includes(kid)) {
    console.error(
      `[micacrypt] keygen refused: the key id '${kid}' is already in the loaded key file; ` +
        'give the new key another id.'
    );
    return;
  }
  for (const line of keygenSteps(kid, serverDataDir())) say(line);
};

/**
 * `micacrypt <status | backfill [--apply] [--batch N] | keygen [kid]>`.
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
