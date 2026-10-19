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
 * same `dispatch`, and no real source ever resolves to a synthetic player. The door installs
 * its players into `FrameworkBridge` (`installSyntheticPlayers`), which throws unless the
 * convar was `1` at start and refuses a second install. The bridge then answers them in two
 * places only. `getPlayer` asks for a source at or below `SYNTHETIC_SOURCE_MAX` (-1,000,000), so a
 * connected player's positive source never reaches the resolver. `getSourcesByCitizenId` asks
 * only for a citizenid its registry and walk missed, so a connected character always answers
 * with their real source. Seeding a citizen the registry has online is refused, and so is
 * invoking for a seeded citizen once a real character has connected under that citizenid, so a
 * synthetic player never acts as a connected character's twin.
 *
 * **A synthetic player may be seeded as an admin** (`{ admin: true }`, for MICA-386's in-server
 * proof of a report's resolve and reopen). `services/Admin.ts`'s `isAdmin` answers a source at
 * or below `SYNTHETIC_SOURCE_MAX` from the bridge's `isSyntheticAdmin` alone, which asks this
 * module's flag and nothing else, so through the door another resource on a harness server can
 * run the admin-gated service actions. That is no more than it could already do in its own
 * code, and it reaches no connected player: every source above the bound takes the ace check as
 * before, and with the convar off at start nothing is installed for the bridge to ask.
 *
 * That is what lets a handler that asks the bridge again after an await (Messages' and
 * PhoneNumbers' MICA-336 guards) run for a synthetic player, and lets a push to one find its
 * source. Every `emitNet` whose target is a synthetic source is captured into that player's
 * buffer instead of reaching the native: an app-event push as its own envelope, and any other
 * event (`mica:client:messages:received`) as `{ app: 'net', event: <name>, payload }`. An emit
 * to a positive source or to `-1` passes through untouched.
 *
 * ── What it is ────────────────────────────────────────────────────────────────────────────
 *
 * - `mica:server:integration:player(citizenid, { bank, admin? }, reply)` seeds a synthetic player
 *   whose bank is a ledger here, an admin only when `admin` is `true`.
 *   `reply({ ok: true, citizenid, source, bank, admin })` or `reply({ ok: false, reason })`.
 * - `mica:server:integration:invoke(service, action, citizenid, payload, reply)` runs the
 *   action's own `dispatch` — limiter, app switch, device, contract parse, `requirePhoneFor`,
 *   the handler — and answers `reply(result, bankAfter)`, where `result` is exactly what
 *   `emitNet` would have carried (`{ error, key }` shapes included), or `null` where the net
 *   path sends nothing.
 * - `mica:server:integration:pushes(citizenid, reply)` answers `reply(envelopes)` with what
 *   was sent to that synthetic citizen since the last ask, and drains it: app-event envelopes,
 *   and every other net event to their source as `{ app: 'net', event, payload, at }`.
 */

import { CITIZENID_MAX_LENGTH } from '@mica/shared/framework';
import { APP_EVENT_NET_EVENT, type AppEventEnvelope } from '@mica/shared/appEvents';
import { dispatcherFor } from './ServiceEndpoint';
import { FrameworkBridge, installSyntheticPlayers, type FrameworkPlayer } from './FrameworkBridge';
import { setPushCapture } from './appEvents';

/** Envelopes kept per synthetic citizen between two `pushes` asks; the oldest go first. */
const PUSH_BUFFER = 200;

/** Synthetic players per process. A harness seeds a handful per scenario; this bounds a loop. */
const MAX_PLAYERS = 500;

/**
 * Synthetic sources count down from here. Never a real server id (FiveM's are positive), never
 * `-1` (`emitNet`'s broadcast target), and refused by every `src > 0` guard in the tree — the
 * registry's `rememberSource`, a call's `notifyParty`. It is `FrameworkBridge`'s
 * `SYNTHETIC_SOURCE_MAX`, the bound at or below which the bridge answers a synthetic player, and
 * is written out rather than imported because a suite's bridge mock need not carry it.
 */
const FIRST_SOURCE = -1_000_000;

interface Synthetic {
  player: FrameworkPlayer;
  ledger: { bank: number };
  pushes: AppEventEnvelope[];
  /** Seeded with `{ admin: true }`: `isAdmin` answers true for this player's source alone. */
  admin: boolean;
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
  const { bank, admin: rawAdmin } = (options ?? {}) as { bank?: unknown; admin?: unknown };
  if (
    typeof citizenid !== 'string' ||
    citizenid.trim() === '' ||
    citizenid.length > CITIZENID_MAX_LENGTH ||
    !movable(bank) ||
    (rawAdmin !== undefined && typeof rawAdmin !== 'boolean')
  ) {
    answer(reply, { ok: false, reason: 'bad_arguments' });
    return;
  }
  // A synthetic twin of a connected character would run that character's rows on a fake wallet.
  // The bridge asks its registry before the door's players, so a source that is not one of ours
  // is a connected character's; one of ours is this citizen seeded before, re-seeded below.
  const online = FrameworkBridge.getSourceByCitizenId(citizenid);
  if (online !== null && !citizenBySyntheticSource.has(online)) {
    answer(reply, { ok: false, reason: 'citizen_online' });
    return;
  }

  // Only a literal `true` grants it; a re-seed without it takes the flag away again.
  const admin = rawAdmin === true;

  const existing = players.get(citizenid);
  if (existing) {
    // Seeding again resets the wallet, the buffer and the flag, and keeps the source.
    existing.ledger.bank = bank;
    existing.pushes.length = 0;
    existing.admin = admin;
    answer(reply, { ok: true, citizenid, source: existing.player.source, bank, admin });
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
    pushes: [],
    admin
  });
  citizenBySyntheticSource.set(source, citizenid);
  answer(reply, { ok: true, citizenid, source, bank, admin });
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
  /**
   * A real character who connected as this citizenid after it was seeded. The bridge asks its
   * registry before the door's players, so a connected twin answers with their own positive
   * source here, and the action is refused rather than run on their rows with the fake wallet.
   */
  if (FrameworkBridge.getSourceByCitizenId(citizenid) !== synthetic.player.source) {
    answer(reply, { error: 'citizen_online' }, bankAfter());
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

/** Keep one envelope for a synthetic citizen, dropping the oldest past the buffer. */
const keep = (synthetic: Synthetic, envelope: AppEventEnvelope): void => {
  synthetic.pushes.push(envelope);
  if (synthetic.pushes.length > PUSH_BUFFER) synthetic.pushes.shift();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What an emit to a synthetic source is kept as. An app-event push is its own envelope, as the
 * shell would receive it. Any other net event becomes `{ app: 'net', event: <name>, payload }`, `persisted: false`,
 * with the payload being its one object argument, or `{ args }` when it sent anything else.
 */
const captured = (eventName: string, args: readonly unknown[]): AppEventEnvelope => {
  const [first] = args;
  if (eventName === APP_EVENT_NET_EVENT && args.length === 1 && isRecord(first)) {
    return first as unknown as AppEventEnvelope;
  }
  return {
    app: 'net',
    event: eventName,
    payload: args.length === 1 && isRecord(first) ? first : { args: [...args] },
    at: Date.now(),
    // A net event writes no notification row; only an app-event push can.
    persisted: false
  };
};

/**
 * Capture everything a handler sends straight to a synthetic source, instead of letting it reach
 * the native.
 *
 * Since the bridge answers synthetic players (`installSyntheticPlayers`), a push finds their
 * source like a connected player's: `appEvents` emits the envelope on `APP_EVENT_NET_EVENT`, and
 * `Messages.deliverToParticipants` emits `mica:client:messages:received`. The synthetic source
 * is not a connection, and what FXServer does with an id that is no player is not something to
 * leave to chance, so each such emit goes into that citizen's buffer, where `pushes` reads it.
 * Only a target that is a synthetic source is taken. A positive source, `-1` (broadcast) and any
 * other value go to the native exactly as they came.
 */
const captureEmitNet = (): void => {
  const native = (globalThis as { emitNet?: unknown }).emitNet;
  if (typeof native !== 'function') return;
  (globalThis as { emitNet: unknown }).emitNet = (
    eventName: string,
    target: unknown,
    ...args: unknown[]
  ): unknown => {
    // `Number`, as the native reads it: a source handed over as a string is the same player.
    const citizenid = citizenBySyntheticSource.get(Number(target));
    const synthetic = citizenid === undefined ? undefined : players.get(citizenid);
    if (synthetic) {
      keep(synthetic, captured(eventName, args));
      return undefined;
    }
    return (native as (...a: unknown[]) => unknown)(eventName, target, ...args);
  };
};

if (GetConvar('mica_integration', '') === '1') {
  const bySource = (src: number): Synthetic | undefined => {
    const citizenid = citizenBySyntheticSource.get(src);
    return citizenid === undefined ? undefined : players.get(citizenid);
  };
  installSyntheticPlayers({
    player: (src) => bySource(src)?.player ?? null,
    sourceOf: (citizenid) => players.get(citizenid)?.player.source ?? null,
    isAdmin: (src) => bySource(src)?.admin === true
  });
  captureEmitNet();
  /**
   * A backstop: with the bridge answering synthetic players, `appEvents` finds their source and
   * emits, which `captureEmitNet` takes. The capture is asked only when no source answers, which
   * for a seeded citizen is never; it stays so a push is never lost between the two.
   */
  setPushCapture((citizenid) => {
    const synthetic = players.get(citizenid);
    if (!synthetic) return null;
    return {
      source: synthetic.player.source,
      deliver: (envelope) => keep(synthetic, envelope)
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
