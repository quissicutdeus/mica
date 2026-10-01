// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import type { Bytes } from 'node:buffer';
import { db } from './db';
import { parseKeyFile } from './sealed';
import { sleep } from './wait';

/** micaOS's export outcome, as `shared/exports.ts` defines it. Restated, not imported. */
export type Outcome<T = unknown> =
  { ok: true; value: T } | { ok: false; reason: string; message: string };

/**
 * Call one of micaOS's exports, from this resource, as any other resource would. An async export
 * answers with a promise across the boundary; awaiting a plain value is harmless, so every call
 * is awaited. A throw here means the export *itself* threw across the boundary, which every
 * export promises never to do.
 */
export const callExport = async <T = unknown>(name: string, ...args: unknown[]): Promise<T> => {
  const mica = (exports as unknown as Record<string, Record<string, unknown>>).mica;
  const fn = mica?.[name];
  if (typeof fn !== 'function') throw new Error(`exports.mica.${name} is not callable`);
  try {
    return (await (fn as (...a: unknown[]) => unknown)(...args)) as T;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`exports.mica.${name} threw across the boundary: ${why}`, { cause: error });
  }
};

const describe = (outcome: unknown): string => {
  try {
    return JSON.stringify(outcome);
  } catch {
    return String(outcome);
  }
};

/** The value of an `ok` outcome, or a throw naming the export and what it said instead. */
export const expectOk = async <T = unknown>(name: string, ...args: unknown[]): Promise<T> => {
  const outcome = await callExport<Outcome<T>>(name, ...args);
  if (!outcome || typeof outcome !== 'object' || outcome.ok !== true) {
    throw new Error(`${name} answered ${describe(outcome)}, not ok`);
  }
  return outcome.value;
};

/** A refusal for exactly `reason`, or a throw saying what came back instead. */
export const expectRefusal = async (
  reason: string,
  name: string,
  ...args: unknown[]
): Promise<void> => {
  const outcome = await callExport<Outcome>(name, ...args);
  if (!outcome || typeof outcome !== 'object' || outcome.ok !== false) {
    throw new Error(`${name} answered ${describe(outcome)}; expected a '${reason}' refusal`);
  }
  if (outcome.reason !== reason) {
    throw new Error(`${name} refused with '${outcome.reason}'; expected '${reason}'`);
  }
};

/** Whether micaOS is up: the resource started and an export answering. */
export const micaReady = async (): Promise<boolean> => {
  if (GetResourceState('mica') !== 'started') return false;
  try {
    const outcome = await callExport<Outcome<number>>('GetApiVersion');
    return outcome?.ok === true;
  } catch {
    return false;
  }
};

/** Run a server console command as the console would, and give it a moment to start. */
export const runCommand = async (command: string): Promise<void> => {
  ExecuteCommand(command);
  await sleep(50);
};

/**
 * The harness's content keys (MICA-165): `mica_content_key_file` names a one-key keyring, kid
 * `it1`. Read from the same file micaOS reads, so a body that opens here was sealed with it.
 */
export const harnessKeys = (): Map<string, Bytes> => {
  const path = GetConvar('mica_content_key_file', '').trim();
  if (path === '') throw new Error('mica_content_key_file is not set; the harness writes one');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // FXServer's filesystem sandbox is the likely cause: the key is read here to prove the
    // stored bodies independently, so this resource needs read access to it as micaOS does.
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`mica-integration cannot read the key file ${path}: ${why}`, { cause: error });
  }
  return parseKeyFile(text);
};

/** The id the harness gives its key, which every new body must name. */
export const HARNESS_KID = 'it1';

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────

/** One per resource start, so two runs against one database never share an id. */
const RUN = Date.now().toString(36);
let serial = 0;

/** A fixture name no other scenario and no other run uses: `itx_<run>_<n>_<label>`. */
export const unique = (label: string): string => `itx_${RUN}_${(serial += 1)}_${label}`;

/** A ten-digit number starting `7`, which no generated micaOS number has the shape of. */
const randomNumber = (): string => `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

export interface Citizen {
  citizenid: string;
  number: string;
}

/**
 * A character micaOS knows offline. On standalone the only record of a player is the number
 * micaOS issued them (`framework/standalone.ts`), so a row in `mica_phone_numbers` is what makes
 * a citizenid resolve — exactly what a player who connected once and left would have.
 */
export const seedCitizen = async (label: string): Promise<Citizen> => {
  const citizenid = unique(label);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = randomNumber();
    const taken = await db.count('SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `number` = ?', [
      number
    ]);
    if (taken > 0) continue;
    await db.insert('INSERT INTO `mica_phone_numbers` (`citizenid`, `number`) VALUES (?, ?)', [
      citizenid,
      number
    ]);
    return { citizenid, number };
  }
  throw new Error('could not find a free phone number for a fixture in five tries');
};

/** A number nobody holds and no line has: for a line, or a sender that is not a character. */
export const freeNumber = async (): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = randomNumber();
    const taken = await db.count('SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `number` = ?', [
      number
    ]);
    if (taken === 0) return number;
  }
  throw new Error('could not find a free phone number in five tries');
};

export const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
