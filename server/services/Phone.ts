// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from '../lib/FrameworkBridge';
import { notifyPlayer } from '../lib/shell';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { guardNetEvent, noInput, phoneNumber, phoneNumberFrom } from '../lib/netGuard';
import { s } from '@mica/shared/schema';
import { phoneCallLog } from './PhoneCallLog';
import { phoneForCitizen } from '../lib/phoneIdentity';
import { readPhoneIdByNumber } from '../lib/phoneNumbers';
import { isAdmin } from './Admin';
import { SEED_CHARACTERS } from '../lib/seed';
import { isBlocked } from './Blocklist';
import {
  lookupLine,
  askLine,
  onLineReleased,
  RING_MAX,
  type RegisteredLine
} from '../lib/numberRegistry';
import { refreshJobLines } from '../lib/jobLines';
import { phoneContract } from '@mica/shared/contracts/phone';
import {
  setSpeaker,
  speakerAvailable,
  speakerDropped,
  speakerOff,
  speakerReleaseAll,
  tickSpeakers,
  __resetSpeakerphone,
  type SpeakerCalls
} from '../lib/speakerphone';

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

/**
 * A call a line answered with `ring` (MICA-307), while nobody has picked it up.
 *
 * `ringing` maps each candidate still ringing to their own number, captured when the ring went
 * out: the winner's call-log row belongs on the phone that rang, and a candidate who drops is
 * no longer someone the framework can answer for. Every candidate's `playerCalls` entry points
 * at the call, so `isInCall` and every busy check hold for them, and the first `answer` from
 * any of them sets `target` and empties this map. After that the call is an ordinary
 * player-to-player call; `group` stays only so the winner's row is written on their own phone.
 */
interface RingGroup {
  line: { number: string; label: string };
  ringing: Map<number, string>;
  /** The winner's own number, set by the answer. */
  answererPhone?: string;
}

// Dictionary to track active calls: CallID -> { caller: source, target: source }
interface ActiveCall {
  id: number;
  caller: number; // Source ID
  /**
   * Source ID. Null only on a ringing group call (`group`), which has candidates rather than a
   * target until one of them answers.
   */
  target: number | null;
  callerPhone: string;
  /** The number the caller dialled: for a group call, the line's own number. */
  targetPhone: string;
  startTime: number;
  /** Set by the `answer` handler. Null means the call never connected. */
  answeredAt: number | null;
  /**
   * The resource whose line answered this call, and so the one `endLineCall` lets end it
   * (MICA-278). Absent on every call a line did not answer, including one it forwarded.
   */
  lineOwner?: string;
  /** Present on a call a line answered with `ring` (MICA-307). */
  group?: RingGroup;
}

/** A group call nobody has answered yet: the only kind with candidates and no target. */
const isRinging = (call: ActiveCall): call is ActiveCall & { group: RingGroup } =>
  call.group !== undefined && call.target === null;

const activeCalls: Record<number, ActiveCall> = {};
const playerCalls: Record<number, number> = {}; // Source -> CallID (Fast lookup)

const generateCallId = () => Math.floor(Math.random() * 900000) + 100000;

/**
 * An id no live call and no reservation holds. Only the group re-key needs the guarantee: a
 * fresh id there is a security property (see `takeGroupCall`), not just a likely-unique key.
 */
const freshCallId = (): number => {
  const held = new Set(Object.values(playerCalls));
  for (;;) {
    const id = generateCallId();
    if (!activeCalls[id] && !held.has(id)) return id;
  }
};

/**
 * Test seam, matching `__resetRateLimits`/`__resetBatteryState`. Both maps are module-scoped
 * and mutated by every handler below, so without this a case that starts, answers or drops a
 * call leaks state into the next one.
 */
export const __resetCalls = (): void => {
  for (const key of Object.keys(activeCalls)) delete activeCalls[Number(key)];
  for (const key of Object.keys(playerCalls)) delete playerCalls[Number(key)];
  nextLineSource = FIRST_LINE_SOURCE;
  __resetSpeakerphone();
};

/**
 * Test seam, read-only: the call held under an id, or undefined. Lets a suite see that a group
 * call answered under a fresh id left nothing under the id its losers were rung with
 * (MICA-307), which no handler can show: every one of them finds a call by its source.
 */
export const __callById = (
  callId: number
): Readonly<{ caller: number; target: number | null }> | undefined => activeCalls[callId];

/**
 * Whether `src` holds a call: ringing, connected, or a line call still waiting on its
 * handler. The same truthiness test `placeCall`'s busy check uses, so the `IsInCall` export
 * and a refused dial can never disagree about one player. Read-only.
 */
export const isInCall = (src: number): boolean => Boolean(playerCalls[src]);

/**
 * Calls are a service with no table: pure signalling, hand-written `onNet` handlers below.
 * The endpoint carries the one contracted action, `speaker` (MICA-246), and every generic
 * CRUD action is off because there is nothing for one to act on.
 */
const phoneEndpoint = new ServiceEndpoint<never, typeof phoneContract>('phone', null, {
  contract: phoneContract,
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

/**
 * What speakerphone may know about calls (`../lib/speakerphone.ts`).
 *
 * Only an answered call counts, and only one with a player on both ends or the console's test
 * caller: a line's far end is a script with no voice, so a bystander would join a channel
 * with nobody in it to hear. The requester must be a party — `playerCalls` already says so,
 * since it is keyed by the parties' own sources.
 */
const speakerCalls: SpeakerCalls = {
  callOf: (src) => {
    const call = activeCalls[playerCalls[src]];
    if (!call || call.answeredAt === null || call.lineOwner !== undefined) return null;
    return call.caller === src || call.target === src ? call.id : null;
  },
  onCall: (src) => Boolean(playerCalls[src])
};

/** Whether the phones on this call are offered a speaker. Never on a line's call. */
const speakerOffered = (call: ActiveCall): boolean =>
  call.lineOwner === undefined && speakerAvailable();

phoneEndpoint.registerEvent('speaker', async (src, _cbId, data) =>
  setSpeaker(src, data.enabled, speakerCalls)
);

/** Once a second, like `Signal.ts`: who is in earshot changes without anybody tapping. */
const SPEAKER_TICK_MS = 1000;
if (typeof setInterval === 'function') {
  setInterval(() => tickSpeakers(speakerCalls), SPEAKER_TICK_MS);
}

/** Bystanders are in a pma-voice channel micaOS put them in; stopping takes them out. */
on('onResourceStop', (resource: string) => {
  if (resource === GetCurrentResourceName()) speakerReleaseAll();
});

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
  // A group call nobody answered has no target, and its candidates get no row: it was the
  // line's call, not theirs (MICA-307). Only the caller's outgoing row is written.
  const targetCitizenid = call.target === null ? null : FrameworkBridge.getCitizenId(call.target);

  if (callerCitizenid) {
    void logCall(callerCitizenid, call.callerPhone, 'outgoing', call.targetPhone, durationSec);
  }
  if (targetCitizenid) {
    void logCall(
      targetCitizenid,
      // The winner of a group ring was rung on their own number, not the line's.
      call.group?.answererPhone ?? call.targetPhone,
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
 * Tell both real parties, log it, and clear both maps.
 *
 * **Both, including whoever ended it** (MICA-232). The side that ends a call is not always a
 * client that has already torn itself down: a battery dying sends `phone:end` from
 * `client/services/Battery.ts` with the call UI and the voice channel still up, and an
 * answer racing a hang-up can leave the ender's client believing it connected. Skipping the
 * ender left its call flag and its pma-voice channel on in both cases. The client's `ended`
 * handler is idempotent, so a second teardown costs nothing; `notifyParty` still skips the
 * console's and a line's negative sources, which are nobody.
 */
function endActiveCall(callId: number): void {
  const call = activeCalls[callId];
  if (!call) return;

  // Every candidate still ringing is told and let go too (MICA-307). Empty once answered.
  const ringing = call.group ? [...call.group.ringing.keys()] : [];
  for (const candidate of ringing) notifyParty('mica:client:phone:ended', candidate);

  notifyParty('mica:client:phone:ended', call.caller);
  if (call.target !== null) notifyParty('mica:client:phone:ended', call.target);

  // Before the maps are cleared, so nobody is left in a channel the call has already left.
  speakerOff(call.caller);
  if (call.target !== null) speakerOff(call.target);

  logCallEnd(call);

  for (const candidate of ringing) releaseCandidateKey(candidate, callId);
  delete playerCalls[call.caller];
  if (call.target !== null) delete playerCalls[call.target];
  delete activeCalls[callId];
}

/**
 * Clear a candidate's key, but only while it still points at this call. A candidate's key is
 * set when the ring goes out and nothing else can claim it while they ring, so the guard is
 * belt and braces against a key that a future path reassigns.
 */
function releaseCandidateKey(candidate: number, callId: number): void {
  if (playerCalls[candidate] === callId) delete playerCalls[candidate];
}

/**
 * One candidate leaves a ringing group call: declined, timed out on their phone, or dropped —
 * all three arrive as `phone:end` or `playerDropped` from that source (MICA-307). Only they are
 * let go and told `ended`. The last to leave ends the call as a single target declining does:
 * the caller is told, and logs the outgoing row to the line's number.
 */
function releaseCandidate(call: ActiveCall & { group: RingGroup }, candidate: number): void {
  call.group.ringing.delete(candidate);
  releaseCandidateKey(candidate, call.id);
  notifyParty('mica:client:phone:ended', candidate);
  if (call.group.ringing.size === 0) endActiveCall(call.id);
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
function releaseCallFor(src: number): boolean {
  const callId = playerCalls[src];
  if (!callId) return false;

  const call = activeCalls[callId];
  if (!call) {
    delete playerCalls[src];
    return true;
  }

  // A candidate on a ringing group call takes only themselves out; the caller ends it all.
  if (isRinging(call) && call.group.ringing.has(src)) {
    releaseCandidate(call, src);
    return true;
  }

  endActiveCall(callId);
  return true;
}

/** Force-end whatever call `targetSrc` is on, without going through their client at all. */
export function endActiveCallFor(targetSrc: number): boolean {
  return releaseCallFor(targetSrc);
}

/** What `endLineCall` did. `no_such_call` covers a call that is not a line's at all. */
export type EndLineCallResult = 'ended' | 'no_such_call' | 'not_owner';

/**
 * Hang up a call a line answered, for the resource that owns the line (MICA-278).
 *
 * Keyed by the `callId` the line's `onCall` handler was given, which is the id the call
 * keeps once accepted. Owned by the resource recorded on the call when it was accepted, not
 * by whoever holds the number now — a released line has already taken its calls down with it
 * (`onLineReleased`), so the two agree today, but the recorded owner cannot drift.
 *
 * A player-to-player call, the console's test call, a forwarded call (a new call between two
 * players, not the line's) and a line call still waiting on its handler are all
 * `no_such_call`: none of them is a call a line answered. Another resource's line call is
 * `not_owner`. Both parties are told `ended` through `endActiveCall`, which skips the line's
 * pseudo-source.
 */
export function endLineCall(callId: unknown, owner: string): EndLineCallResult {
  if (typeof callId !== 'number' || !Number.isInteger(callId)) return 'no_such_call';
  const call = activeCalls[callId];
  if (!call || call.lineOwner === undefined) return 'no_such_call';
  if (call.lineOwner !== owner) return 'not_owner';

  endActiveCall(call.id);
  return 'ended';
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
 * Named for what happened to the call, not for which branch fired. `'placed'` is the call
 * ringing or connected; `'unreachable'` and `'busy'` are the two refusals the caller's own
 * phone was told about (toast, reset event, and for unreachable a call-log row); the last
 * two are the silent early returns, where nothing happened and nothing told anyone.
 *
 * `'unreachable'` is one value on purpose (MICA-64): a number nobody holds, a blocked
 * caller, and a line that rejected or went away all arrive here as the same word, after the
 * same work, so `CreateCall` (`publicApi.ts`) hands nothing to a script that the caller's
 * own phone does not already show. Before MICA-276 every one of these was `'placed'`, and
 * a dispatch resource could not tell a connected call from one that had already failed.
 */
export type PlaceCallResult =
  'placed' | 'unreachable' | 'busy' | 'caller_has_no_phone' | 'invalid_target';

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
  // A number nobody answers for may be a job line the owner has just `set` (MICA-307): look
  // at the convar once more before the lookup, so the first call after the change reaches it.
  if (!targetSrc && !lookupLine(targetPhone)) refreshJobLines();
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
   * The one **unblockable** target is the configured emergency number, whoever is answering
   * it — normally a *player* (a dispatcher on 911), which is why this is a number test and not
   * a line test. It skips the check entirely rather than calling `isBlocked` and having the
   * answer not matter, so a blocked emergency number, however that arose, is never asked about.
   *
   * A line's `blockable` does not enter into it (MICA-278). The question asked here is
   * whether the *target* blocked the *caller*, and a line blocks nobody: blocking a line means
   * a player blocking the line's number, which refuses what the line sends *them* — its texts,
   * in `Messages.deliverToParticipants`. A line never places a call, so that has no call half.
   * A line target therefore asks about `''` and matches nothing, and asks anyway, because the
   * query is what keeps a registered number costing the same to dial as a made-up one before
   * the line's handler runs. (The handler's own latency still shows — see `connectLineCall`.)
   *
   * There is nothing to bypass for DND or signal — neither has ever gated a call here; DND
   * only suppresses a *notification* (`web/src/shell/state/notificationPolicy.ts`) and
   * signal has never refused one on this file's own evidence — so "connects regardless of
   * them" already holds for every call, unblockable or not.
   */
  const unblockable = targetPhone === emergencyNumber();

  const blocked = !unblockable && (await isBlocked(targetPlayer?.citizenid ?? '', callerPhone));

  // A line is never refused by that answer, only timed by it — see above.
  if (!targetSrc && line) {
    return connectLineCall(src, callerPhone, targetPhone, line);
  }

  // One word for both, deliberately — see `PlaceCallResult`. The `isBlocked` await above
  // has already happened on every path, so the return value adds no timing to what the
  // caller's phone was told.
  if (!targetSrc || blocked) {
    failUnreachable(src, targetPhone);
    return 'unreachable';
  }

  if (targetSrc === src) {
    notifyPlayer(src, { type: 'error', message: 'Busy', key: 'server.phone.busy' });
    emitNet('mica:client:phone:failed', src);
    return 'busy';
  }

  if (playerCalls[targetSrc] || playerCalls[src]) {
    notifyPlayer(src, { type: 'error', message: 'Line busy', key: 'server.phone.lineBusy' });
    emitNet('mica:client:phone:failed', src);
    return 'busy';
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
): Promise<PlaceCallResult> {
  if (playerCalls[src]) {
    notifyPlayer(src, { type: 'error', message: 'Line busy', key: 'server.phone.lineBusy' });
    emitNet('mica:client:phone:failed', src);
    return 'busy';
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
  // nothing of ours to release. `'placed'` is the honest word: the call went out and the
  // caller, not micaOS, decided how it ended — the same as hanging up on a ringing player.
  if (playerCalls[src] !== callId) return 'placed';

  // The *line* can also go away inside that same window: `releaseResource` sweeps the numbers
  // a stopping resource held, and the `onLineReleased` hook below only reaches calls that
  // already exist — this one does not yet, so the sweep cannot see it. Connecting anyway
  // would leave the caller on a silent call whose far end is a dead function ref, endable
  // only by their own hangup. Compared by identity rather than presence, because a
  // re-registration inside the window is a different line and this verdict is not its answer.
  if (lookupLine(targetPhone) !== line) {
    delete playerCalls[src];
    failUnreachable(src, targetPhone);
    return 'unreachable';
  }

  // A forward re-dials by the target's own number, which cannot land back here: a number a
  // character holds is refused at registration and loses to the player lookup on every call,
  // so `placeCall` resolves it down the player path.
  //
  // Two things make that re-dial reach nothing, and neither is hypothetical: a `source`
  // nobody is connected on, and a connected player whose `phone` is null, which is an
  // ordinary ESX shape rather than a broken one. Both arrive as a number `phoneNumberFrom`
  // refuses, and `placeCall`'s refusals for a bad number are silent by design. So its answer
  // is checked rather than discarded: a silent refusal means nothing was emitted, and the
  // caller — whose reservation is already released — would otherwise sit on the dialling
  // screen with no toast and no call-log row until they hung up themselves. The re-dial's
  // own refusals (`'unreachable'`, `'busy'`) have already told the caller and pass through.
  if (verdict.action === 'forward') {
    // Released before re-entering, or `placeCall`'s own busy check would refuse the caller
    // the call this line just asked for.
    delete playerCalls[src];
    const redial = await placeCall(src, FrameworkBridge.getPlayerPhone(verdict.source) ?? '');
    if (redial === 'invalid_target' || redial === 'caller_has_no_phone') {
      failUnreachable(src, targetPhone);
      return 'unreachable';
    }
    return redial;
  }

  if (verdict.action === 'ring') {
    return ringGroup(src, callerPhone, targetPhone, line, callId, verdict.sources, verdict.max);
  }

  // `askLine` answers `reject` for a handler that throws, hangs or returns nonsense, so a
  // broken integration produces the same *content* as a number nobody holds: same message,
  // same call-log row, same client event (MICA-64's shape). Not the same timing, though — a
  // number nobody holds fails on the spot, while a line's rejection waits on somebody else's
  // handler and can take up to `HANDLER_TIMEOUT_MS`. So a line's existence stays detectable
  // by a caller with a stopwatch; only the content half of that guarantee holds here.
  if (verdict.action !== 'accept') {
    delete playerCalls[src];
    failUnreachable(src, targetPhone);
    return 'unreachable';
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
    answeredAt: Date.now(),
    lineOwner: line.owner
  };
  // `playerCalls[src]` is already this call — claimed before the await above.
  playerCalls[lineSource] = callId;

  emitNet('mica:client:phone:accepted', src, { callId, speaker: false });
  return 'placed';
}

/**
 * Ring every player a line named, and let the first to answer take the call (MICA-307).
 *
 * Runs after `askLine`'s await and the two re-checks after it, so the caller's reservation is
 * still `callId`. Candidates are judged here, after the await, rather than by the handler: one
 * who started a call of their own inside the handler's window is already in `playerCalls` and
 * is skipped like any other busy player. The caller is never their own candidate, and a source
 * with no phone number cannot be rung. Only then is the list cut to `max` (never more than
 * `RING_MAX`), in the order given, so free staff are never hidden behind busy ones. Nobody left
 * fails exactly like an unreachable number (MICA-64's shape), with no new word for "everybody
 * was busy" — a "Line busy" here would tell any caller whether staff are on duty.
 *
 * The caller is told nothing until somebody answers, as when ringing one player.
 */
function ringGroup(
  src: number,
  callerPhone: string,
  targetPhone: string,
  line: RegisteredLine,
  callId: number,
  sources: readonly number[],
  max: number | undefined
): PlaceCallResult {
  const limit = Math.min(max ?? RING_MAX, RING_MAX);
  const ringing = new Map<number, string>();
  for (const candidate of sources) {
    if (ringing.size >= limit) break;
    if (candidate === src || playerCalls[candidate]) continue;
    const phone = FrameworkBridge.getPlayerPhone(candidate);
    if (!phone) continue;
    ringing.set(candidate, phone);
  }

  if (ringing.size === 0) {
    delete playerCalls[src];
    failUnreachable(src, targetPhone);
    return 'unreachable';
  }

  const lineInfo = { number: line.number, label: line.label ?? line.number };
  activeCalls[callId] = {
    id: callId,
    caller: src,
    target: null,
    callerPhone,
    targetPhone,
    startTime: Date.now(),
    answeredAt: null,
    // No `lineOwner`: once answered this is a call between two players, so it is offered a
    // speaker and `endLineCall` answers `no_such_call` for it, as for a forwarded call.
    group: { line: lineInfo, ringing }
  };
  // `playerCalls[src]` is already this call — claimed before the await in `connectLineCall`.
  for (const candidate of ringing.keys()) {
    playerCalls[candidate] = callId;
    // `line` is new and optional: a client that does not read it shows an ordinary call.
    notifyParty('mica:client:phone:incoming', candidate, {
      from: callerPhone,
      callId,
      line: lineInfo
    });
  }
  return 'placed';
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
    if (call.targetPhone === number && call.target !== null && call.target <= FIRST_LINE_SOURCE) {
      endActiveCall(call.id);
    }
    // A group call still ringing is the line's too, and goes with it (MICA-307). Once answered
    // it is a call between two players and stays up, as a forwarded call does.
    if (isRinging(call) && call.group.line.number === number) {
      endActiveCall(call.id);
    }
  }
});

/** The dialled number, and nothing else (MICA-210). */
const START_INPUT = s.tuple([phoneNumber]);

onNet('mica:server:phone:start', async (...args: unknown[]) => {
  // Rate limit, parse and authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got none of the three until this; see `lib/netGuard.ts`.
  const guarded = guardNetEvent('phone', 'start', START_INPUT, args);
  if (!guarded) return;
  const [target] = guarded.input;

  await placeCall(source, target);
});

onNet('mica:server:phone:answer', (...args: unknown[]) => {
  // Rate limit, parse and authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got none of the three until this; see `lib/netGuard.ts`.
  if (!guardNetEvent('phone', 'answer', noInput, args)) return;

  const src = source;
  const call = activeCalls[playerCalls[src]];
  if (!call) return;

  if (isRinging(call)) {
    if (!call.group.ringing.has(src)) return;
    takeGroupCall(call, src);
  } else if (call.target !== src) {
    return;
  }

  call.answeredAt = Date.now();

  // `speaker` is whether the phone shows the control at all (MICA-246): hidden, not dead,
  // on a server whose voice setup cannot carry one. `call.id`, not the id looked up above:
  // a group call has just been re-keyed by `takeGroupCall`.
  const speaker = speakerOffered(call);
  const { id: callId } = call;
  notifyParty('mica:client:phone:accepted', call.caller, { callId, speaker });
  // `src` is the target on both paths above: a player's own call, or the group call they won.
  notifyParty('mica:client:phone:accepted', src, { callId, speaker });
});

/**
 * The first candidate to answer a group call takes it (MICA-307).
 *
 * Synchronous from the `answer` handler's own lookup to here, so two answers cannot both win:
 * the second finds `target` set and `isRinging` false, and is not the target. Everyone else is
 * told `ended` and let go, with no call-log row — it was never their call. Not audit-logged:
 * the moderation ledger is no place for routine line traffic, and the winner's row says who.
 */
function takeGroupCall(call: ActiveCall & { group: RingGroup }, winner: number): void {
  const { ringing } = call.group;
  const oldId = call.id;
  call.target = winner;
  call.group.answererPhone = ringing.get(winner);
  const losers = [...ringing.keys()].filter((candidate) => candidate !== winner);
  ringing.clear();
  for (const loser of losers) {
    releaseCandidateKey(loser, oldId);
    notifyParty('mica:client:phone:ended', loser);
  }

  // Re-keyed, because the id is the voice channel: the client joins pma-voice on the id in
  // `accepted`, pma-voice lets any client join any channel, and every loser was sent the old
  // id in `incoming`. Answered under a fresh id, the losers hold one that names nothing.
  const newId = freshCallId();
  delete activeCalls[oldId];
  call.id = newId;
  activeCalls[newId] = call;
  playerCalls[call.caller] = newId;
  playerCalls[winner] = newId;
}

onNet('mica:server:phone:end', (...args: unknown[]) => {
  if (!guardNetEvent('phone', 'end', noInput, args)) return;

  releaseCallFor(source);
});

// Clean up on drop
on('playerDropped', () => {
  const src = source;
  releaseCallFor(src);
  speakerDropped(src);
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
/**
 * An optional caller number. Blank or absent falls back to `DEFAULT_TEST_NUMBER`, the
 * same way `micacall` with no argument does; anything that is not phone-number-shaped is
 * refused rather than defaulted, since the button only ever sends a string or nothing.
 */
const SIMULATE_INCOMING_INPUT = s.tuple([s.string({ trim: true, max: 32 }).optional()]);

onNet('mica:server:phone:simulateIncoming', (...args: unknown[]) => {
  const guarded = guardNetEvent('phone', 'simulateIncoming', SIMULATE_INCOMING_INPUT, args);
  if (!guarded) return;
  const [number] = guarded.input;

  const src = source;
  if (!isAdmin(src)) return;

  injectIncomingCall(src, number || DEFAULT_TEST_NUMBER);
});
