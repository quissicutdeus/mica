// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The integration door (MICA-397): the in-server suite (`integration/`, MICA-302) drives a
 * service action as a synthetic player, inside a real FXServer, against a real database.
 *
 * ── Security ──────────────────────────────────────────────────────────────────────────────
 *
 * **Off unless `mica_integration` is `1` when micaOS starts, and then local only.** Read once,
 * at resource start: a live `set mica_integration 1` on a running server opens nothing until
 * micaOS restarts, and a live `set … 0` closes nothing. With it off this module registers no
 * event, installs no capture and wraps nothing — the only trace is `ServiceEndpoint`'s map of
 * dispatch functions, which is a module variable no other resource and no client can reach.
 *
 * With it on, the three events are registered with `on()`, **never a net event**: FXServer
 * delivers a client's `TriggerServerEvent` only to a handler registered for the network, so no
 * client — modified or not, through the generic NUI relay (`shared/rpc.ts`) or around it — can
 * reach them. There is no export. What can reach them is another resource on the same server,
 * which can already run any server code it likes; the door gives it nothing it did not have,
 * and it exists only on the harness's servers, which set the convar.
 *
 * What the door adds for a connected client is nothing: the net event and the door run the
 * same `dispatch`, and the door's players are not in `FrameworkBridge`'s registry, so no real
 * source ever resolves to one and no push for a real citizen is ever captured
 * (`appEvents.setPushCapture` is asked only for a citizen no source answers for, and seeding a
 * citizen who is online is refused).
 *
 * ── What it is ────────────────────────────────────────────────────────────────────────────
 *
 * - `mica:server:integration:player(citizenid, { bank }, reply)` seeds a synthetic player whose
 *   bank is a ledger here. `reply({ ok: true, citizenid, source, bank })` or
 *   `reply({ ok: false, reason })`.
 * - `mica:server:integration:invoke(service, action, citizenid, payload, reply)` runs the
 *   action's own `dispatch` — limiter, app switch, device, contract parse, `requirePhoneFor`,
 *   the handler — and answers `reply(result, bankAfter)`, where `result` is exactly what
 *   `emitNet` would have carried (`{ error, key }` shapes included), or `null` where the net
 *   path sends nothing.
 * - `mica:server:integration:pushes(citizenid, reply)` answers `reply(envelopes)` with the
 *   app-event envelopes pushed to that synthetic citizen since the last ask, and drains them.
 */

import { CITIZENID_MAX_LENGTH } from '@mica/shared/framework';
import type { AppEventEnvelope } from '@mica/shared/appEvents';
import { dispatcherFor } from './ServiceEndpoint';
import { FrameworkBridge, type FrameworkPlayer } from './FrameworkBridge';
import { setPushCapture } from './appEvents';

/** Envelopes kept per synthetic citizen between two `pushes` asks; the oldest go first. */
const PUSH_BUFFER = 200;

/** Synthetic players per process. A harness seeds a handful per scenario; this bounds a loop. */
const MAX_PLAYERS = 500;

/**
 * Synthetic sources count down from here. Never a real server id (FiveM's are positive), never
 * `-1` (`emitNet`'s broadcast target), and refused by every `src > 0` guard in the tree — the
 * registry's `rememberSource`, a call's `notifyParty`.
 */
const FIRST_SOURCE = -1000;

interface Synthetic {
  player: FrameworkPlayer;
  ledger: { bank: number };
  pushes: AppEventEnvelope[];
}

const players = new Map<string, Synthetic>();
const citizenBySyntheticSource = new Map<number, string>();
let nextSource = FIRST_SOURCE;

/** A sum a ledger can move: finite and not negative, the shape every framework accepts. */
const movable = (amount: unknown): amount is number =>
  typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;

/**
 * A `FrameworkPlayer` over a ledger. The bank moves and answers `true`; cash answers as
 * standalone does (`-Infinity`, `false`), without its console line. A debit past the balance is
 * refused, as a framework refuses one. Items, jobs and metadata are the empty answers a player
 * with no framework record gives.
 */
const syntheticPlayer = (citizenid: string, source: number, ledger: { bank: number }) => {
  const player: FrameworkPlayer = {
    citizenid,
    source,
    getMoney: (type) => (type === 'bank' ? ledger.bank : Number.NEGATIVE_INFINITY),
    removeMoney: (type, amount) => {
      if (type !== 'bank' || !movable(amount) || amount > ledger.bank) return false;
      ledger.bank -= amount;
      return true;
    },
    addMoney: (type, amount) => {
      if (type !== 'bank' || !movable(amount)) return false;
      ledger.bank += amount;
      return true;
    },
    setMeta: () => {},
    removeItem: () => false,
    setPhone: () => true,
    getJobs: () => [],
    setActiveJob: () => false,
    setDuty: () => false,
    rawPlayer: { PlayerData: { citizenid, charinfo: {}, metadata: {} } }
  };
  return player;
};

/** Call a reply the caller handed across the resource boundary, never letting it throw here. */
const answer = (reply: unknown, ...args: unknown[]): void => {
  if (typeof reply !== 'function') {
    console.error('[mica] integration door: a request carried no reply function; dropped.');
    return;
  }
  try {
    (reply as (...a: unknown[]) => unknown)(...args);
  } catch (error) {
    console.error('[mica] integration door: the reply threw:', error);
  }
};

const seed = (citizenid: unknown, options: unknown, reply: unknown): void => {
  const bank = (options as { bank?: unknown } | null)?.bank;
  if (
    typeof citizenid !== 'string' ||
    citizenid.trim() === '' ||
    citizenid.length > CITIZENID_MAX_LENGTH ||
    !movable(bank)
  ) {
    answer(reply, { ok: false, reason: 'bad_arguments' });
    return;
  }
  // A synthetic twin of a connected character would run that character's rows on a fake wallet.
  if (FrameworkBridge.getSourceByCitizenId(citizenid) !== null) {
    answer(reply, { ok: false, reason: 'citizen_online' });
    return;
  }

  const existing = players.get(citizenid);
  if (existing) {
    // Seeding again resets the wallet and the buffer and keeps the source.
    existing.ledger.bank = bank;
    existing.pushes.length = 0;
    answer(reply, { ok: true, citizenid, source: existing.player.source, bank });
    return;
  }
  if (players.size >= MAX_PLAYERS) {
    answer(reply, { ok: false, reason: 'too_many_players' });
    return;
  }

  const source = nextSource;
  nextSource -= 1;
  const ledger = { bank };
  players.set(citizenid, {
    player: syntheticPlayer(citizenid, source, ledger),
    ledger,
    pushes: []
  });
  citizenBySyntheticSource.set(source, citizenid);
  answer(reply, { ok: true, citizenid, source, bank });
};

const invoke = async (
  service: unknown,
  action: unknown,
  citizenid: unknown,
  payload: unknown,
  reply: unknown
): Promise<void> => {
  if (typeof service !== 'string' || typeof action !== 'string' || typeof citizenid !== 'string') {
    answer(reply, { error: 'bad_arguments' }, null);
    return;
  }
  const synthetic = players.get(citizenid);
  const bankAfter = (): number | null => synthetic?.ledger.bank ?? null;

  const dispatch = dispatcherFor(service, action);
  if (!dispatch) {
    answer(reply, { error: 'unknown_action' }, bankAfter());
    return;
  }
  if (!synthetic) {
    answer(reply, { error: 'unknown_player' }, null);
    return;
  }

  let result: unknown = null;
  try {
    await dispatch({
      src: synthetic.player.source,
      cbId: 'integration',
      data: payload,
      rawDevice: undefined,
      lookup: (src) => (src === synthetic.player.source ? synthetic.player : null),
      reply: (value) => {
        result = value;
      }
    });
  } catch (error) {
    // `dispatch` answers its own errors; reaching here is a bug in the door, not the action.
    console.error(`[mica] integration door: ${service}:${action} threw past its dispatch:`, error);
    result = { error: 'door_failed' };
  }
  answer(reply, result, bankAfter());
};

const drain = (citizenid: unknown, reply: unknown): void => {
  const synthetic = typeof citizenid === 'string' ? players.get(citizenid) : undefined;
  answer(reply, synthetic ? synthetic.pushes.splice(0) : []);
};

/**
 * Stop anything a handler sends straight to a synthetic source from reaching the native.
 *
 * Most handlers answer through their return value, which the door's `reply` takes, and push
 * through `appEventChannel`, which the capture takes. A few `emitNet` to the caller's source
 * themselves (a call's speaker, a music broadcast). The synthetic source is no connection, and
 * what FXServer does with an id that is no player is not something to leave to chance, so those
 * are dropped here, with one line per event name.
 */
const guardEmitNet = (): void => {
  const native = (globalThis as { emitNet?: unknown }).emitNet;
  if (typeof native !== 'function') return;
  const reported = new Set<string>();
  (globalThis as { emitNet: unknown }).emitNet = (
    eventName: string,
    target: unknown,
    ...args: unknown[]
  ): unknown => {
    if (citizenBySyntheticSource.has(Number(target))) {
      if (!reported.has(eventName)) {
        reported.add(eventName);
        console.log(
          `[mica] integration door: dropped '${eventName}' to synthetic source ${String(target)}; ` +
            'only replies and app-event pushes are captured.'
        );
      }
      return undefined;
    }
    return (native as (...a: unknown[]) => unknown)(eventName, target, ...args);
  };
};

if (GetConvar('mica_integration', '') === '1') {
  guardEmitNet();
  setPushCapture((citizenid) => {
    const synthetic = players.get(citizenid);
    if (!synthetic) return null;
    return {
      source: synthetic.player.source,
      deliver: (envelope) => {
        synthetic.pushes.push(envelope);
        if (synthetic.pushes.length > PUSH_BUFFER) synthetic.pushes.shift();
      }
    };
  });
  on('mica:server:integration:player', seed);
  on('mica:server:integration:invoke', invoke);
  on('mica:server:integration:pushes', drain);
  console.log(
    '[mica] integration door OPEN (mica_integration=1): another resource on this server can run ' +
      'service actions as synthetic players. This is for the in-server suite; never set it on a ' +
      'live server.'
  );
}
