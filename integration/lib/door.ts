// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eventually, type Signal } from './wait';

/**
 * micaOS's integration door (MICA-397, `server/lib/integrationDoor.ts`): a service action run as
 * a synthetic player, through the action's own `dispatch` — limiter, app switch, device, contract
 * parse, `requirePhoneFor`, handler — with its reply and its app-event pushes handed back here.
 *
 * The door is three local events, and each takes a reply function as its last argument. `emit`
 * carries a function across resources as a function reference, which the receiving resource can
 * call (the same mechanism as ESX's `TriggerEvent('esx:getSharedObject', cb)`). micaOS registers
 * the events only when `mica_integration` is `1` at its start; when it did not, an `emit` reaches
 * nobody and the reply never comes, so every ask here has a deadline that says so rather than
 * hanging the scenario until its own limit names nothing.
 *
 * **A synthetic player holds no phone item.** `spin` and `crashStart` are `requirePhoneFor`
 * actions, which count `mica_phone_item` in the player's inventory when it is set; the door's
 * players have none, so they are refused there. The standalone run sets no `mica_phone_item`
 * (only the qbx and esx runs do), so a door scenario that stakes money belongs to that run.
 */

/** Long enough for a dispatch that waits on the database; short enough to name a closed door. */
const DOOR_TIMEOUT_MS = 15_000;

/** An app-event envelope as `shared/appEvents.ts` defines it. Restated, not imported. */
export interface PushEnvelope {
  app: string;
  event: string;
  payload: Record<string, unknown>;
  /** Server clock, ms, when the push was sent. */
  at: number;
}

export interface SyntheticPlayer {
  citizenid: string;
  source: number;
  bank: number;
}

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Emit one door event with a reply function last, and resolve with what the reply carried. */
const ask = (event: string, args: readonly unknown[]): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `the integration door did not answer ${event} within ${DOOR_TIMEOUT_MS} ms; micaOS ` +
            'registers it only when mica_integration is 1 at its start'
        )
      );
    }, DOOR_TIMEOUT_MS);
    const reply = (...values: unknown[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(values);
    };
    emit(event, ...args, reply);
  });

/**
 * Seed (or re-seed) a synthetic player with `bank` in a ledger the door keeps. Re-seeding the
 * same citizen resets the bank and drops its unread pushes, and keeps its synthetic source, so
 * its rate-limit windows carry over: a scenario takes a fresh `unique()` citizen instead.
 */
export const seedPlayer = async (citizenid: string, bank: number): Promise<SyntheticPlayer> => {
  const [answer] = await ask('mica:server:integration:player', [citizenid, { bank }]);
  const seeded = answer as { ok?: unknown; reason?: unknown } & Partial<SyntheticPlayer>;
  if (!seeded || seeded.ok !== true) {
    throw new Error(`the door refused to seed ${citizenid}: ${describe(answer)}`);
  }
  return { citizenid, source: Number(seeded.source), bank: Number(seeded.bank) };
};

export interface Invoked<T> {
  /** Exactly what the net path would have sent the client; `{ error, key }` on a refusal. */
  result: T;
  /** The synthetic player's bank after the action, or null when the door knew no player. */
  bank: number | null;
}

/** Run `<service>:<action>` as `citizenid` and take the reply as it comes, refusals included. */
export const invoke = async <T = unknown>(
  service: string,
  action: string,
  citizenid: string,
  payload: unknown = {}
): Promise<Invoked<T>> => {
  const [result, bank] = await ask('mica:server:integration:invoke', [
    service,
    action,
    citizenid,
    payload
  ]);
  return { result: result as T, bank: typeof bank === 'number' ? bank : null };
};

/**
 * `invoke`, failing on an `{ error }` answer: the door's own (`unknown_action`,
 * `unknown_player`, `bad_arguments`) or the endpoint's (rate limit, app switch, phone, payload).
 * A service's own `{ ok: false, reason }` is a reply, not an error, and comes back as one.
 */
export const call = async <T = unknown>(
  service: string,
  action: string,
  citizenid: string,
  payload: unknown = {}
): Promise<Invoked<T>> => {
  const invoked = await invoke<T>(service, action, citizenid, payload);
  const result = invoked.result as unknown;
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`${service}:${action} answered an error: ${describe(result)}`);
  }
  return invoked;
};

/** The envelopes pushed to `citizenid` since the last ask, oldest first. Drains them. */
export const pushes = async (citizenid: string): Promise<PushEnvelope[]> => {
  const [envelopes] = await ask('mica:server:integration:pushes', [citizenid]);
  return Array.isArray(envelopes) ? (envelopes as PushEnvelope[]) : [];
};

/**
 * Ask for pushes until one matches, for up to `timeoutMs`, polling as `eventually` does. Every
 * envelope read is drained and one that does not match is dropped, so match on what identifies
 * the push (a round id), not only on its event name.
 */
export const waitForPush = async (
  citizenid: string,
  match: (envelope: PushEnvelope) => boolean,
  timeoutMs: number,
  signal: Signal,
  what: string
): Promise<PushEnvelope> =>
  await eventually(
    async () => (await pushes(citizenid)).find(match) ?? null,
    timeoutMs,
    signal,
    what
  );
