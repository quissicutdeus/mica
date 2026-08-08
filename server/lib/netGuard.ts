import { FrameworkBridge } from './FrameworkBridge';
import { allow } from './rateLimit';

/**
 * The preamble every `onNet` handler needs, in one place.
 *
 * `ServiceEndpoint` applies rate limiting and authentication to every action it registers.
 * Eight handlers in `Phone.ts`, `Battery.ts` and `Signal.ts` are raw `onNet` listeners
 * instead — they answer fire-and-forget events with no callback id, so they cannot go
 * through the endpoint — and they had neither. A modified client could drive any of them
 * in a loop, as an unauthenticated source.
 *
 * Rate limit **before** the player lookup, matching `ServiceEndpoint`: `getPlayer` walks
 * the framework's player table, and a flood should not get to make the server pay for
 * that. A caller with no loaded character still has a source and can still emit events.
 *
 * Returns the player rather than a boolean, because every one of these needs it next and
 * looking it up twice is how the two checks drift apart.
 *
 * ```ts
 * onNet('gphone:server:phone:answer', () => {
 *   const player = guardNetEvent('phone', 'answer');
 *   if (!player) return;
 *   …
 * });
 * ```
 *
 * **Silently**, deliberately. These events carry no callback id, so there is nobody
 * waiting on a reply to be told why — where `ServiceEndpoint` answers a refusal because
 * `fetchNui` is waiting and would otherwise hang for fifteen seconds.
 */
export function guardNetEvent(service: string, action: string) {
  const src = source;

  if (!allow(src, service, action)) return null;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return null;

  return player;
}

/**
 * A phone number off the wire, or null.
 *
 * `phone:start` interpolates nothing and passes this to `FrameworkBridge.getPlayerByPhone`,
 * so the risk is not injection — it is an unbounded value reaching another resource's
 * lookup, and a non-string reaching a function that expects one. Bounded and typed here so
 * the framework only ever sees something phone-number-shaped.
 */
export function phoneNumberFrom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 32) return null;
  return trimmed;
}

/**
 * A 0-100 level off the wire, clamped, or null when it is not a number at all.
 *
 * Clamping rather than refusing an out-of-range value: the request is legitimate and only
 * the number is not, which is the same call `SetBatteryLevel` makes. `null` is reserved
 * `null` is reserved for the cases where the client sent something that was never a level
 * at all: `undefined`, a non-numeric string, an object, `NaN`.
 */
export function levelFrom(raw: unknown): number | null {
  /**
   * `Number()` alone is not enough, and this is the part that bit.
   *
   * `Number(null)` is `0`, and `Number('')` is `0` — so a client sending nothing at all
   * produced a perfectly valid "0% battery" rather than a refusal. Only a real number, or
   * a string that is entirely a number, counts.
   */
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;

  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
