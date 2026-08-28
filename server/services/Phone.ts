import { FrameworkBridge } from '../lib/FrameworkBridge';
import { notifyPlayer } from '../lib/shell';
import { registerService } from '../lib/services';
import { guardNetEvent, phoneNumberFrom } from '../lib/netGuard';
import { phoneCallLog } from './PhoneCallLog';
import { isAdmin } from './Admin';
import { SEED_CHARACTERS } from '../lib/seed';

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
    void phoneCallLog.repo.create({
      citizenid: callerCitizenid,
      kind: 'outgoing',
      number: call.targetPhone,
      duration: durationSec
    });
  }
  if (targetCitizenid) {
    void phoneCallLog.repo.create({
      citizenid: targetCitizenid,
      kind: answered ? 'incoming' : 'missed',
      number: call.callerPhone,
      duration: durationSec
    });
  }
}

/**
 * Notify whoever's still owed one, log it, and clear both maps. `endedBy` is whichever
 * side already knows — the real `end` handler's own caller, or `CONSOLE_CALLER_SOURCE`
 * for a console-driven teardown, which is nobody, so both real parties get notified.
 */
function endActiveCall(callId: number, endedBy: number): void {
  const call = activeCalls[callId];
  if (!call) return;

  if (call.caller !== endedBy) emitNet('gphone:client:phone:ended', call.caller);
  if (call.target !== endedBy) emitNet('gphone:client:phone:ended', call.target);

  logCallEnd(call);

  delete playerCalls[call.caller];
  delete playerCalls[call.target];
  delete activeCalls[callId];
}

/**
 * `gphonecall` support (MICA-55): a synthetic source nothing real ever holds, so an
 * injected call's "caller" can never collide with an actual connected player. Recognizable
 * on sight in a console dump, too.
 */
const CONSOLE_CALLER_SOURCE = -1;

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
  emitNet('gphone:client:phone:incoming', targetSrc, { from: callerPhone, callId });
  return callId;
}

/** Force-end whatever call `targetSrc` is on, without going through their client at all. */
export function endActiveCallFor(targetSrc: number): boolean {
  const callId = playerCalls[targetSrc];
  if (!callId) return false;
  endActiveCall(callId, CONSOLE_CALLER_SOURCE);
  return true;
}

onNet('gphone:server:phone:start', (rawTarget: unknown) => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'start');
  if (!player) return;

  // Typed and bounded before it reaches `getPlayerByPhone`, which belongs to the
  // framework rather than to us. Not injection — an unbounded or non-string value
  // reaching somebody else's lookup.
  const targetPhone = phoneNumberFrom(rawTarget);
  if (!targetPhone) return;

  const src = source;
  const callerPhone = FrameworkBridge.getPlayerPhone(src);

  if (!callerPhone) return;

  // Look up target via FrameworkBridge
  const targetPlayer = FrameworkBridge.getPlayerByPhone(targetPhone);
  const targetSrc = targetPlayer?.source || null;

  if (!targetSrc) {
    // A number nobody answered is still a call the player placed, and a phone lists it.
    // This path creates no `ActiveCall`, so `logCallEnd` — the only other writer — never
    // runs for it and Recents was simply unchanged after dialling an unreachable number
    // (MICA-95). Duration 0 and kind 'outgoing' is exactly what `logCallEnd` writes for
    // a call that rang and was never answered, so the two paths agree.
    //
    // Issued before the `failed` push, which is what sends the caller's phone back to
    // idle and makes it refetch the log, so the row is already on its way by then.
    const callerCitizenid = FrameworkBridge.getCitizenId(src);
    if (callerCitizenid) {
      void phoneCallLog.repo.create({
        citizenid: callerCitizenid,
        kind: 'outgoing',
        number: targetPhone,
        duration: 0
      });
    }

    notifyPlayer(src, { type: 'error', message: 'Number unavailable' });
    // Tell client to reset
    emitNet('gphone:client:phone:failed', src);
    return;
  }

  if (targetSrc === src) {
    notifyPlayer(src, { type: 'error', message: 'Busy' });
    emitNet('gphone:client:phone:failed', src);
    return;
  }

  if (playerCalls[targetSrc] || playerCalls[src]) {
    notifyPlayer(src, { type: 'error', message: 'Line busy' });
    emitNet('gphone:client:phone:failed', src);
    return;
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
  emitNet('gphone:client:phone:incoming', targetSrc, {
    from: callerPhone,
    callId: callId
  });
});

onNet('gphone:server:phone:answer', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'answer');
  if (!player) return;

  const src = source;
  const callId = playerCalls[src];
  const call = activeCalls[callId];

  if (!call || call.target !== src) return;

  call.answeredAt = Date.now();

  emitNet('gphone:client:phone:accepted', call.caller, { callId });
  emitNet('gphone:client:phone:accepted', call.target, { callId });
});

onNet('gphone:server:phone:end', () => {
  // Rate limit *and* authenticate, in the order `ServiceEndpoint` uses. Raw `onNet`
  // handlers got neither until this; see `lib/netGuard.ts`.
  const player = guardNetEvent('phone', 'end');
  if (!player) return;

  const src = source;
  const callId = playerCalls[src];
  if (!callId) return;

  endActiveCall(callId, src);
});

// Clean up on drop
on('playerDropped', () => {
  const src = source;
  const callId = playerCalls[src];
  if (callId) {
    endActiveCall(callId, src);
  }
});

/**
 * `gphonecall` — ring yourself, in game, with one player (MICA-55).
 *
 * `Phone.ts`'s own state machine requires a second connected player: `start` refuses a
 * self-call as "Busy", and `getPlayerByPhone` only ever finds someone online. This is
 * the lever around both — `injectIncomingCall` fakes the peer and nothing else, so the
 * rest of the path (NUI focus, the `callStatus` messages, the pma-voice join on answer)
 * is exactly what a real call drives.
 *
 * `gphonecall [number]`     — ring yourself from an arbitrary number
 * `gphonecall <firstname>`  — ring yourself as a seeded character (`gphoneseed`),
 *                             mirroring `gphoneseed text <firstname>`
 * `gphonecall end`          — force-end your own active call
 */

const respondCall = (source: number, message: string, type: 'success' | 'error' = 'success') => {
  if (source === 0) {
    console.log(`[gphonecall] ${message}`);
    return;
  }
  notifyPlayer(source, { type, title: 'gphonecall', message });
};

const DEFAULT_TEST_NUMBER = '5550100';

RegisterCommand(
  'gphonecall',
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
 * The NUI-reachable twin of `gphonecall [number]`, for Settings > Developer Tools'
 * "Simulate Incoming Call" — see `DeveloperTools.svelte`'s `triggerCall`. In a browser
 * that button fakes the toast locally, since there is no server to ask; in game it has
 * to go through here, the same as `applyBatteryLevel` ten lines above it in that file
 * routes through `setBatteryLevel` instead of setting client-only state. Admin-gated
 * independently of whatever the UI shows — a NUI request is not proof of intent (§2.9).
 */
onNet('gphone:server:phone:simulateIncoming', (rawNumber: unknown) => {
  const player = guardNetEvent('phone', 'simulateIncoming');
  if (!player) return;

  const src = source;
  if (!isAdmin(src)) return;

  const number = phoneNumberFrom(rawNumber) ?? DEFAULT_TEST_NUMBER;
  injectIncomingCall(src, number);
});
