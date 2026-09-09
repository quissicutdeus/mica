// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from '../lib/FrameworkBridge';
import { notifyPlayer } from '../lib/shell';
import { registerService } from '../lib/services';
import { guardNetEvent, phoneNumberFrom } from '../lib/netGuard';
import { phoneCallLog } from './PhoneCallLog';
import { phoneForCitizen } from '../lib/phoneIdentity';
import { readPhoneIdByNumber } from '../lib/phoneNumbers';
import { isAdmin } from './Admin';
import { SEED_CHARACTERS } from '../lib/seed';
import { isBlocked } from './Blocklist';
import { lookupLine, askLine, onLineReleased, type RegisteredLine } from '../lib/numberRegistry';

const EMERGENCY_NUMBER_CONVAR = 'mica_emergency_number';
const DEFAULT_EMERGENCY_NUMBER = '911';

/**
 * The number that always connects (MICA-64), read per call like `Hodlr.ts`'s
 * `tradeMax`/`spreadPct` rather than cached — a server owner changing it with `set` from
 * the console should not need a restart.
 *
 * `phoneNumberFrom` normalises it the same way any dialed number is normalised, so a
 * convar set to `" 911 "` still compares equal to what a player actually dials.
 */
const emergencyNumber = (): string =>
  phoneNumberFrom(GetConvar(EMERGENCY_NUMBER_CONVAR, DEFAULT_EMERGENCY_NUMBER)) ??
  DEFAULT_EMERGENCY_NUMBER;

/** For `GetEmergencyNumber` (`publicApi.ts`) — a dispatch resource's own setup code. */
export const currentEmergencyNumber = (): string => emergencyNumber();

/**
 * micaOS deliberately does not register the emergency number as a line of its own.
 *
 * `registerNumber` (`../lib/numberRegistry`) refuses a number a different owner already
 * holds, and `unregisterNumber` only lets the current owner give it back — so micaOS
 * claiming 911 at boot would permanently lock out the one thing this number exists for: a
 * dispatch resource calling `RegisterNumber('911', …)` to actually answer it. Nothing here
 * needs a line to hold the exemption anyway — `targetPhone === emergencyNumber()` in
 * `placeCall` below grants it directly, whether or not anybody, script or player, is on the
 * number at all.
 */

// Dictionary to track active calls: CallID -> { caller: source, target: source }
interface ActiveCall {
  id: number;
  caller: number; // Source ID
  target: number; // Source ID
  callerPhone: string;
  targetPhone: string;
  startTime: number;
  /** Set by the `answer` handler. Null means the call never connected. */
  answeredAt: number | null;
}

const activeCalls: Record<number, ActiveCall> = {};
const playerCalls: Record<number, number> = {}; // Source -> CallID (Fast lookup)

const generateCallId = () => Math.floor(Math.random() * 900000) + 100000;

/**
 * Test seam, matching `__resetRateLimits`/`__resetBatteryState`. Both maps are module-scoped
 * and mutated by every handler below, so without this a case that starts, answers or drops a
 * call leaks state into the next one.
 */
export const __resetCalls = (): void => {
  for (const key of Object.keys(activeCalls)) delete activeCalls[Number(key)];
  for (const key of Object.keys(playerCalls)) delete playerCalls[Number(key)];
  nextLineSource = FIRST_LINE_SOURCE;
};

/**
 * Calls are a service with no endpoint and no table: pure signalling, hand-written
 * handlers below. Declared so the `<service>` segment resolves like any other.
 */
const PHONE_SERVICE = registerService('phone');
void PHONE_SERVICE;

/**
 * Writes one call-log row per participant. Called from every path a call can end
 * through — `end` (hangup, decline, or a client-side timeout, which all resolve to
 * the same event) and `playerDropped` — so "missed" always means the same thing
 * regardless of why the target never answered.
 */
function logCallEnd(call: ActiveCall): void {
  const answered = call.answeredAt !== null;
  const durationSec = answered ? Math.round((Date.now() - call.answeredAt!) / 1000) : 0;

  const callerCitizenid = FrameworkBridge.getCitizenId(call.caller);
  const targetCitizenid = FrameworkBridge.getCitizenId(call.target);

  if (callerCitizenid) {
    void logCall(callerCitizenid, call.callerPhone, 'outgoing', call.targetPhone, durationSec);
  }
  if (targetCitizenid) {
    void logCall(
      targetCitizenid,
      call.targetPhone,
      answered ? 'incoming' : 'missed',
      call.callerPhone,
      durationSec
    );
  }
}

/**
 * One call-log row, on the phone the number was used from (MICA-282).
 *
 * The phone that owns `ownNumber` is the phone the call happened on — the caller dialled from
 * it, the callee was rung on it — so that is where the row belongs, whoever holds it later.
 * A number micaOS has no row for (ESX) falls back to whichever phone the citizen is on. Never
 * throws: a call log that could not be written is a line in the log, not a failed call.
 */
async function logCall(
  citizenid: string,
  ownNumber: string,
  kind: 'incoming' | 'outgoing' | 'missed',
  number: string,
  duration: number
): Promise<void> {
  try {
    const phone_id = (await readPhoneIdByNumber(ownNumber)) ?? (await phoneForCitizen(citizenid));
    await phoneCallLog.repo.create({ citizenid, phone_id, kind, number, duration });
  } catch (error) {
    console.error(`[mica] could not log a ${kind} call for ${citizenid}.`, error);
  }
}

/**
 * Emit to one side of a call, and only if somebody is actually there (MICA-277).
 *
 * A call's two sides are server ids, and two kinds of side are not real players: the
 * console's `CONSOLE_CALLER_SOURCE` (-1) and a line's pseudo-source (-2 and below). FiveM's
 * `emitNet` treats -1 specially — it **broadcasts to every connected client** — so an
 * `ended` addressed to the console caller reached the whole server, and
 * `client/services/Call.ts` acts on `phone:ended` unconditionally: one admin-injected test
 * call, ended normally by its target, dropped every player from whatever call they were on.
 * `accepted` had the same hole, one step earlier, and puts every client into a voice call.
 *
 * Guarded here, at the emit, rather than at each caller, so that nothing that ever ends,
 * answers or fails a call has to remember which negative number is the special one. A line
 * pseudo-source below -1 is not special to `emitNet` — it addresses nobody and is dropped —
 * but it is not a player either, and skipping it is the honest reading of "nobody there".
 */
const notifyParty = (event: string, src: number, payload?: unknown): void => {
  if (!Number.isInteger(src) || src <= 0) return;
  if (payload === undefined) emitNet(event, src);
  else emitNet(event, src, payload);
};

/**
 * Notify whoever's still owed one, log it, and clear both maps. `endedBy` is whichever
 * side already knows — the real `end` handler's own caller, or `CONSOLE_CALLER_SOURCE`
 * for a console-driven teardown, which is nobody, so both real parties get notified.
 */
function endActiveCall(callId: number, endedBy: number): void {
  const call = activeCalls[callId];
  if (!call) return;

  if (call.caller !== endedBy) notifyParty('mica:client:phone:ended', call.caller);
  if (call.target !== endedBy) notifyParty('mica:client:phone:ended', call.target);

  logCallEnd(call);

  delete playerCalls[call.caller];
  delete playerCalls[call.target];
  delete activeCalls[callId];
}

/**
 * `micacall` support (MICA-55): a synthetic source nothing real ever holds, so an
 * injected call's "caller" can never collide with an actual connected player. Recognizable
 * on sight in a console dump, too.
 */
const CONSOLE_CALLER_SOURCE = -1;

/**
 * The far end of a line call gets its own negative source, one per call.
 *
 * `playerCalls` is keyed by source, so every live call needs a key nothing else is using.
 * `CONSOLE_CALLER_SOURCE` is a single sentinel and cannot serve: two players talking to one
 * taxi line at once would share the key, and ending either call would delete the other's
 * entry from under it. Counting down from -2 leaves -1 to the console and hands out a fresh
 * key per call. Every behaviour a negative source already has still holds — `getCitizenId`
 * answers null, so `logCallEnd` writes no row for this side, and `notifyParty` sends nothing
 * to it. That last part is where the two negative kinds differ, and it is the reason the
 * guard exists: `-1` is the one negative source `emitNet` treats as "everyone" (MICA-277),
 * where a line's pseudo-source merely addresses nobody. The keying is the same; the emit is
 * not, and `notifyParty` is what makes both read as "nobody there".
 */
const FIRST_LINE_SOURCE = -2;
let nextLineSource = FIRST_LINE_SOURCE;
const allocateLineSource = (): number => nextLineSource--;

/**
 * Ring `targetSrc` from `callerPhone` with no real caller behind it. Everything past this
 * point is the genuine client/server path — NUI focus, the `callStatus` messages, the
 * pma-voice join on answer — with only the peer faked. `logCallEnd` already skips writing
 * a caller-side row for a source with no citizenid behind it, so ending this call logs
 * correctly on the target's side alone.
 */
export function injectIncomingCall(targetSrc: number, callerPhone: string): number | null {
  if (playerCalls[targetSrc]) return null;

  const callId = generateCallId();
  const call: ActiveCall = {
    id: callId,
    caller: CONSOLE_CALLER_SOURCE,
    target: targetSrc,
    callerPhone,
    targetPhone: FrameworkBridge.getPlayerPhone(targetSrc) ?? '',
    startTime: Date.now(),
    answeredAt: null
  };

  activeCalls[callId] = call;
  playerCalls[targetSrc] = callId;
  emitNet('mica:client:phone:incoming', targetSrc, { from: callerPhone, callId });
  return callId;
}

/**
 * Drop whatever `src` holds — an established call, or a reservation with no call behind it.
 *
 * `connectLineCall` claims `playerCalls[src]` before it awaits a handler owned by another
 * resource, so for up to `HANDLER_TIMEOUT_MS` a source can hold a key whose `ActiveCall`
 * does not exist yet. Releasing that key is also how a caller who hangs up mid-ring tells
 * that path to abandon the call, since it re-checks the key before connecting.
 * `endActiveCall` cannot do this on its own: it is keyed by call id and returns early when
 * no call answers to it, which would leave the reservation held until the resource stopped.
 *
 * Returns whether anything was held.
 */
function releaseCallFor(src: number, endedBy: number): boolean {
  const callId = playerCalls[src];
  if (!callId) return false;

  if (!activeCalls[callId]) {
    delete playerCalls[src];
    return true;
  }

  endActiveCall(callId, endedBy);
  return true;
}

/** Force-end whatever call `targetSrc` is on, without going through their client at all. */
export function endActiveCallFor(targetSrc: number): boolean {
  return releaseCallFor(targetSrc, CONSOLE_CALLER_SOURCE);
}

/**
 * The one failure shape a blocked call and a genuinely unreachable number must share
 * (MICA-64) — a blocked caller must not be able to tell the two apart, including by
 * watching their own Recents. Before this existed, "nobody holds that number" logged a
 * call-log row (MICA-95's own fix) while a blocked call logged nothing at all, which
 * would have been exactly the tell a "does not confirm the block" caller is promised not
 * to get: dial a made-up number and a real blocked one, and only one leaves a row.
 */
function failUnreachable(src: number, targetPhone: string): void {
  const callerCitizenid = FrameworkBridge.getCitizenId(src);
  if (callerCitizenid) {
    void logCall(
      callerCitizenid,
      FrameworkBridge.getPlayerPhone(src) ?? '',
      'outgoing',
      targetPhone,
      0
    );
  }

  // Issued before the `failed` push, which is what sends the caller's phone back to idle
  // and makes it refetch the log, so the row is already on its way by then.
  notifyPlayer(src, {
    type: 'error',
    message: 'Number unavailable',
    key: 'server.phone.numberUnavailable'
  });
  emitNet('mica:client:phone:failed', src);
}

/**
 * What `placeCall` actually did, for a caller that needs to know.
 *
 * `'placed'` covers everything from here on out — ringing, busy, blocked, unreachable — all
 * of which are visible to `src` through a client event or a call connecting. The other two
 * are the silent early returns: nothing happened and nothing told anyone, which is exactly
 * the gap `CreateCall` (`publicApi.ts`) needs to not paper over with a bare `ok()`.
 */
export type PlaceCallResult = 'placed' | 'caller_has_no_phone' | 'invalid_target';

/**
 * Place a call from `src` to a dialed number, whatever placed it.
 *
 * Extracted from the `start` handler so `phone:start` and the `CreateCall` export share one
 * body rather than one of them growing its own subtly different rules — the whole point of
 * §2.9 being enforced here is that there is exactly one place a call can be set up. The
 * `onNet` handler ignores the return value, since a client that dialed badly already sees
 * nothing happen; `CreateCall` cannot afford to, since its caller gets no such visual cue.
 */
export async function placeCall(src: number, rawTarget: unknown): Promise<PlaceCallResult> {
  // Typed and bounded before it reaches `getPlayerByPhone`, which belongs to the
  // framework rather than to us. Not injection — an unbounded or non-string value
  // reaching somebody else's lookup.
  const targetPhone = phoneNumberFrom(rawTarget);
  if (!targetPhone) return 'invalid_target';

  const callerPhone = FrameworkBridge.getPlayerPhone(src);
  if (!callerPhone) return 'caller_has_no_phone';

  // A character always wins over a registered line, so a number the framework later
  // issues to a real player stops reaching the script rather than intercepting them.
  const targetPlayer = FrameworkBridge.getPlayerByPhone(targetPhone);
  const targetSrc = targetPlayer?.source || null;
  const line = targetSrc ? undefined : lookupLine(targetPhone);

  /**
   * A blocked call fails exactly like an unreachable one (MICA-64) — same message, same
   * call-log row, same client event — so the caller learns nothing about *why* it failed.
   *
   * This check runs unconditionally, even when `targetPlayer` doesn't exist, rather than
   * only in the reachable branch: awaiting `isBlocked` is a real DB round trip, so gating
   * it behind "does a player hold this number" would let a caller distinguish "real
   * number" from "made up" purely by response time, regardless of what the two failure
   * paths return (Wolffe's review, MICA-64). Passing a citizenid that can never match a
   * row (`''` when there's no target) keeps the query's cost identical either way while
   * still always resolving to `false` for an unreachable number.
   *
   * An **unblockable** target skips the check entirely, rather than calling `isBlocked` and
   * having the answer not matter: it is decided before the (async) lookup, so a blocked
   * emergency number — however that arose — is never even asked about. Two things make a
   * target unblockable, and they are independent:
   *
   * - The configured emergency number, whoever is answering it. This term must not be
   *   folded into the line term below: the emergency number is normally held by a *player*
   *   (a dispatcher on 911), and `line` is only ever looked up when no player holds the
   *   number, so a line-only condition would quietly make a staffed 911 blockable again.
   * - A line registered with `blockable: false` (MICA-226), which is how a script says its
   *   number is infrastructure rather than a person.
   *
   * The `true` half of that second term is a timing guarantee and nothing more, which is
   * worth saying plainly because the code reads as though it does more. A blocklist row is
   * keyed by the *blocking* character's citizenid, and a line has none — so a blockable
   * line asks about `''`, matches no row, and can never actually be blocked. The `await`
   * still has to happen: skip it and a registered number becomes measurably faster to dial
   * than a made-up one, which is the side channel the paragraph above exists to close.
   * Blocking a line by number is a separate ticket, not something this branch does today.
   *
   * There is nothing to bypass for DND or signal — neither has ever gated a call here; DND
   * only suppresses a *notification* (`web/src/shell/state/notificationPolicy.ts`) and
   * signal has never refused one on this file's own evidence — so "connects regardless of
   * them" already holds for every call, unblockable or not.
   */
  const unblockable = targetPhone === emergencyNumber() || (line ? !line.blockable : false);

  const blocked = !unblockable && (await isBlocked(targetPlayer?.citizenid ?? '', callerPhone));

  if (!targetSrc && line && !blocked) {
    await connectLineCall(src, callerPhone, targetPhone, line);
    return 'placed';
  }

  if (!targetSrc || blocked) {
    failUnreachable(src, targetPhone);
    return 'placed';
  }

  if (targetSrc === src) {
    notifyPlayer(src, { type: 'error', message: 'Busy', key: 'server.phone.busy' });
    emitNet('mica:client:phone:failed', src);
    return 'placed';
  }

  if (playerCalls[targetSrc] || playerCalls[src]) {
    notifyPlayer(src, { type: 'error', message: 'Line busy', key: 'server.phone.lineBusy' });
    emitNet('mica:client:phone:failed', src);
    return 'placed';
  }

  const callId = generateCallId();
  const call: ActiveCall = {
    id: callId,
    caller: src,
    target: targetSrc,
    callerPhone,
    targetPhone,
    startTime: Date.now(),
    answeredAt: null
  };

  activeCalls[callId] = call;
  playerCalls[src] = callId;
  playerCalls[targetSrc] = callId;

  // Notify receiving player
  emitNet('mica:client:phone:incoming', targetSrc, {
    from: callerPhone,
    callId: callId
  });
  return 'placed';
}

/**
 * Ring a script-owned line and act on its verdict.
 *
 * `accept` connects through the same `accepted` event a player answering emits, so the
 * caller's UI shows a connected call — there is no second client on the other end, so
 * nothing joins pma-voice and the script is expected to be doing the talking some other
 * way. `forward` instead re-enters `placeCall` at a real player's own number, which is what
 * keeps voice, blocking and call logging identical to a call dialed directly.
 */
async function connectLineCall(
  src: number,
  callerPhone: string,
  targetPhone: string,
  line: RegisteredLine
): Promise<void> {
  if (playerCalls[src]) {
    notifyPlayer(src, { type: 'error', message: 'Line busy', key: 'server.phone.lineBusy' });
    emitNet('mica:client:phone:failed', src);
    return;
  }

  const callId = generateCallId();

  // Claim the caller's key *before* awaiting a handler that belongs to another resource and
  // may take up to `HANDLER_TIMEOUT_MS` — a window whose length that resource controls. Read
  // without claiming, a second `start` inside it passes the busy check too, and its call
  // overwrites this key, orphaning an `ActiveCall` that neither `end` nor `playerDropped`
  // can reach again. Every path out of here below either connects on this key or releases it.
  playerCalls[src] = callId;

  const verdict = await askLine(line, { from: callerPhone, source: src, callId });

  // The caller hung up or dropped while the handler was thinking: `releaseCallFor` took the
  // key back (or a newer call of theirs owns it now), so there is nobody left to connect and
  // nothing of ours to release.
  if (playerCalls[src] !== callId) return;

  // The *line* can also go away inside that same window: `releaseResource` sweeps the numbers
  // a stopping resource held, and the `onLineReleased` hook below only reaches calls that
  // already exist — this one does not yet, so the sweep cannot see it. Connecting anyway
  // would leave the caller on a silent call whose far end is a dead function ref, endable
  // only by their own hangup. Compared by identity rather than presence, because a
  // re-registration inside the window is a different line and this verdict is not its answer.
  if (lookupLine(targetPhone) !== line) {
    delete playerCalls[src];
    failUnreachable(src, targetPhone);
    return;
  }

  // A forward re-dials by the target's own number, which cannot land back here: a number a
  // character holds is refused at registration and loses to the player lookup on every call,
  // so `placeCall` resolves it down the player path.
  //
  // Two things make that re-dial reach nothing, and neither is hypothetical: a `source`
  // nobody is connected on, and a connected player whose `phone` is null, which is an
  // ordinary ESX shape rather than a broken one. Both arrive as a number `phoneNumberFrom`
  // refuses, and `placeCall`'s refusals for a bad number are silent by design. So its answer
  // is checked rather than discarded: anything but `'placed'` means nothing was emitted, and
  // the caller — whose reservation is already released — would otherwise sit on the dialling
  // screen with no toast and no call-log row until they hung up themselves.
  if (verdict.action === 'forward') {
    // Released before re-entering, or `placeCall`'s own busy check would refuse the caller
    // the call this line just asked for.
    delete playerCalls[src];
    if ((await placeCall(src, FrameworkBridge.getPlayerPhone(verdict.source) ?? '')) !== 'placed')
      failUnreachable(src, targetPhone);
    return;
  }

  // `askLine` answers `reject` for a handler that throws, hangs or returns nonsense, so a
  // broken integration produces the same *content* as a number nobody holds: same message,
  // same call-log row, same client event (MICA-64's shape). Not the same timing, though — a
  // number nobody holds fails on the spot, while a line's rejection waits on somebody else's
  // handler and can take up to `HANDLER_TIMEOUT_MS`. So a line's existence stays detectable
  // by a caller with a stopwatch whatever `blockable` says; only the content half of that
  // guarantee holds here.
  if (verdict.action !== 'accept') {
    delete playerCalls[src];
    failUnreachable(src, targetPhone);
    return;
  }

  const lineSource = allocateLineSource();
  activeCalls[callId] = {
    id: callId,
    caller: src,
    target: lineSource,
    callerPhone,
    targetPhone,
    startTime: Date.now(),
    // Answered on the spot: the handler already said yes, so there is no ringing state a
    // second client would otherwise have to leave.
    answeredAt: Date.now()
  };
  // `playerCalls[src]` is already this call — claimed before the await above.
  playerCalls[lineSource] = callId;

  emitNet('mica:client:phone:accepted', src, { callId });
}

/**
 * A line that goes away takes its live calls with it.
 *
 * Registered from here rather than called from `numberRegistry.ts` because `lib/` must not
 * import `services/`. Without it a caller connected to a stopped resource is left on a call
 * whose far end is a dead function ref and which only their own hangup can end.
 */
onLineReleased((number: string) => {
  for (const call of Object.values(activeCalls)) {
    // `targetPhone` alone over-matches: a player-to-player call stores the dialled number in
    // the same field, so a number the framework has since reassigned to a real character
    // would see that call torn down too. Only a line call has a line pseudo-source on the
    // far end, and `FIRST_LINE_SOURCE` is the highest of those.
    if (call.targetPhone === number && call.target <= FIRST_LINE_SOURCE) {
      endActiveCall(call.id, CONSOLE_CALLER_SOURCE);
    }
  }
});

onNet('mica:server:phone:start', async (rawTarget: unknown) => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'start');
  if (!player) return;

  await placeCall(source, rawTarget);
});

onNet('mica:server:phone:answer', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'answer');
  if (!player) return;

  const src = source;
  const callId = playerCalls[src];
  const call = activeCalls[callId];

  if (!call || call.target !== src) return;

  call.answeredAt = Date.now();

  notifyParty('mica:client:phone:accepted', call.caller, { callId });
  notifyParty('mica:client:phone:accepted', call.target, { callId });
});

onNet('mica:server:phone:end', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'end');
  if (!player) return;

  releaseCallFor(source, source);
});

// Clean up on drop
on('playerDropped', () => {
  releaseCallFor(source, source);
});

/**
 * `micacall` — ring yourself, in game, with one player (MICA-55).
 *
 * `Phone.ts`'s own state machine requires a second connected player: `start` refuses a
 * self-call as "Busy", and `getPlayerByPhone` only ever finds someone online. This is
 * the lever around both — `injectIncomingCall` fakes the peer and nothing else, so the
 * rest of the path (NUI focus, the `callStatus` messages, the pma-voice join on answer)
 * is exactly what a real call drives.
 *
 * `micacall [number]`     — ring yourself from an arbitrary number
 * `micacall <firstname>`  — ring yourself as a seeded character (`micaseed`),
 *                             mirroring `micaseed text <firstname>`
 * `micacall end`          — force-end your own active call
 */

const respondCall = (source: number, message: string, type: 'success' | 'error' = 'success') => {
  if (source === 0) {
    console.log(`[micacall] ${message}`);
    return;
  }
  notifyPlayer(source, { type, title: 'micacall', message });
};

const DEFAULT_TEST_NUMBER = '5550100';

RegisterCommand(
  'micacall',
  (source: number, args: string[]) => {
    if (!isAdmin(source)) {
      respondCall(source, 'You do not have permission to use that.', 'error');
      return;
    }
    if (source === 0) {
      respondCall(source, 'Run this in game as the player you want to ring.', 'error');
      return;
    }

    const arg = (args?.[0] ?? '').trim();

    if (arg.toLowerCase() === 'end') {
      const ended = endActiveCallFor(source);
      respondCall(
        source,
        ended ? 'Call ended.' : "You aren't on a call.",
        ended ? 'success' : 'error'
      );
      return;
    }

    const seeded = SEED_CHARACTERS.find((c) => c.firstname.toLowerCase() === arg.toLowerCase());
    const callerPhone = seeded
      ? seeded.phone
      : (phoneNumberFrom(arg || DEFAULT_TEST_NUMBER) ?? DEFAULT_TEST_NUMBER);

    const callId = injectIncomingCall(source, callerPhone);
    if (callId === null) {
      respondCall(source, "You're already on a call.", 'error');
      return;
    }
    respondCall(source, `Ringing from ${seeded ? seeded.firstname : callerPhone}.`);
  },
  false
);

/**
 * The NUI-reachable twin of `micacall [number]`, for Settings > Developer Tools'
 * "Simulate Incoming Call" — see `DeveloperTools.svelte`'s `triggerCall`. In a browser
 * that button fakes the toast locally, since there is no server to ask; in game it has
 * to go through here, the same as `applyBatteryLevel` ten lines above it in that file
 * routes through `setBatteryLevel` instead of setting client-only state. Admin-gated
 * independently of whatever the UI shows — a NUI request is not proof of intent (§2.9).
 */
onNet('mica:server:phone:simulateIncoming', (rawNumber: unknown) => {
  const player = guardNetEvent('phone', 'simulateIncoming');
  if (!player) return;

  const src = source;
  if (!isAdmin(src)) return;

  const number = phoneNumberFrom(rawNumber) ?? DEFAULT_TEST_NUMBER;
  injectIncomingCall(src, number);
});
