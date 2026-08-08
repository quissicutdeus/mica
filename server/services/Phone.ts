import { FrameworkBridge } from '../lib/FrameworkBridge';
import { notifyPlayer } from '../lib/shell';
import { registerService } from '../lib/services';
import { guardNetEvent, phoneNumberFrom } from '../lib/netGuard';

// Dictionary to track active calls: CallID -> { caller: source, target: source }
interface ActiveCall {
  id: number;
  caller: number; // Source ID
  target: number; // Source ID
  callerPhone: string;
  targetPhone: string;
  startTime: number;
}

const activeCalls: Record<number, ActiveCall> = {};
const playerCalls: Record<number, number> = {}; // Source -> CallID (Fast lookup)

const generateCallId = () => Math.floor(Math.random() * 900000) + 100000;

/**
 * Calls are a service with no endpoint and no table: pure signalling, hand-written
 * handlers below. Declared so the `<service>` segment resolves like any other.
 */
const PHONE_SERVICE = registerService('phone');
void PHONE_SERVICE;

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
    startTime: Date.now()
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
  const call = activeCalls[callId];

  if (!call) return;

  // Notify both
  if (call.caller !== src) emitNet('gphone:client:phone:ended', call.caller);
  if (call.target !== src) emitNet('gphone:client:phone:ended', call.target);

  // Clean up
  delete playerCalls[call.caller];
  delete playerCalls[call.target];
  delete activeCalls[callId];
});

// Clean up on drop
on('playerDropped', () => {
  const src = source;
  const callId = playerCalls[src];
  if (callId) {
    const call = activeCalls[callId];
    // End for other party
    const other = call.caller === src ? call.target : call.caller;
    emitNet('gphone:client:phone:ended', other);

    delete playerCalls[other];
    delete playerCalls[src];
    delete activeCalls[callId];
  }
});
