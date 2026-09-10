// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { s, type GphoneSchema } from '@mica/shared/schema';
import { FrameworkBridge, type FrameworkPlayer } from './FrameworkBridge';
import { allow } from './rateLimit';

/**
 * The preamble every `onNet` handler needs, in one place.
 *
 * `ServiceEndpoint` applies rate limiting, authentication and a declared input schema to
 * every action it registers. Eleven handlers are raw `onNet` listeners instead — they answer
 * fire-and-forget events with no callback id, so they cannot go through the endpoint — and
 * they had none of the three. A modified client could drive any of them in a loop, as an
 * unauthenticated source, with whatever positional arguments it liked.
 *
 * Nine are mica-named, across `Phone.ts`, `Battery.ts`, `Contacts.ts`, `PhoneOpenState.ts`
 * and `phoneItem.ts`. The other two are framework-named. `QBCore:Server:OnPlayerLoaded` in
 * `shell.ts` reaches this preamble through `loadedPlayerSource`. `qb-phone:server:sendNewMail`
 * in `qbPhoneCompat.ts` (MICA-222) is answered on purpose so qb scripts work unmodified, and
 * applies the same checks inline -- `allow`, then `getPlayer`, then its own `qbMailFrom` --
 * because the only thing it can do is mail the source. `docs/security.md` explains why that
 * category was missed for so long: an entry-point census organised by mica event names has
 * no row for an event somebody else named.
 *
 * **That category used to have three rows, and the drop is a smaller attack surface rather
 * than a recount.** `Settings.ts` and `Battery.ts` each registered the same framework event
 * themselves, pasted from `shell.ts`, which is why all three carried MICA-136's payload
 * bug at once. `shell.ts` now owns every player-loaded entry point and they subscribe to it
 * through `onPlayerLoaded`, so they are handed a source that has already been established —
 * a subscriber cannot misread an identity it is never shown. `esx:playerLoaded` is
 * deliberately not in this list: it is registered with `on`, so it is not net-safe inside
 * micaOS and no client can reach it.
 *
 * Recount rather than trusting this comment, which has been wrong before:
 * `grep -rn "onNet(" server --include="*.ts" | grep -v __tests__`. That returns thirteen
 * lines for eleven handlers — the other two are `ServiceEndpoint.ts`'s own generic registrar
 * and the example below, neither a handler.
 *
 * **The schema is a required argument, not an option (MICA-210).** MICA-195 put a declared
 * input in front of every `registerEvent` handler; these events carry positional scalars
 * rather than a keyed payload, so each one declares its arguments as an `s.tuple([...])`
 * and hands the raw argument list here. The tuple is parsed before the handler body runs,
 * so the body reads typed values and never `unknown`. `phoneNumber`, `batteryLevel` and
 * `noInput` below are the shared elements; a handler-specific shape (the shared contact
 * card, the open-state push) lives beside its handler. `netGuardCensus.test.ts` proves every
 * raw handler passes one, and the compiler refuses a call without it.
 *
 * Rate limit **before** the parse and the player lookup, matching `ServiceEndpoint`:
 * `getPlayer` walks the framework's player table, and a flood should not get to make the
 * server pay for that. The parse sits between the two because it is pure and cheap, so a
 * malformed payload never costs the lookup either. A caller with no loaded character still
 * has a source and can still emit events.
 *
 * Returns the player and the parsed input together rather than a boolean, because every
 * one of these needs both next and looking the player up twice is how the checks drift
 * apart.
 *
 * ```ts
 * const START = s.tuple([phoneNumber]);
 * onNet('mica:server:phone:start', (...args: unknown[]) => {
 *   const guarded = guardNetEvent('phone', 'start', START, args);
 *   if (!guarded) return;
 *   const [target] = guarded.input;
 *   …
 * });
 * ```
 *
 * **Silently**, deliberately, and a schema refusal is as silent as the other two. These
 * events carry no callback id, so there is nobody waiting on a reply to be told why — where
 * `ServiceEndpoint` answers a refusal because `fetchNui` is waiting and would otherwise hang
 * for fifteen seconds. Nothing is logged either: a line per packet is a log an attacker
 * writes as much of as they like (`shell.ts`'s once-per-connection `refuse` is the one
 * deliberate exception, for the ordering bug that would otherwise be invisible).
 */
export interface GuardedNetEvent<T> {
  player: FrameworkPlayer;
  input: T;
}

export function guardNetEvent<T>(
  service: string,
  action: string,
  schema: GphoneSchema<T>,
  args: readonly unknown[]
): GuardedNetEvent<T> | null {
  const src = source;

  if (!allow(src, service, action)) return null;

  const outcome = schema['~standard'].validate(args);
  // Every micaOS schema resolves synchronously; `GphoneSchema` is the parameter type so a
  // foreign async validator cannot be handed in and leave the handler with a Promise.
  if (outcome instanceof Promise || outcome.issues) return null;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return null;

  return { player, input: outcome.value };
}

/** An event that takes nothing. Any argument carrying a value is refused. */
export const noInput = s.tuple([]);

/**
 * A phone number off the wire: text, trimmed, not blank, at most 32 characters.
 *
 * `phone:start` interpolates nothing and passes this to `FrameworkBridge.getPlayerByPhone`,
 * so the risk is not injection — it is an unbounded value reaching another resource's
 * lookup, and a non-string reaching a function that expects one. Bounded and typed here so
 * the framework only ever sees something phone-number-shaped.
 */
export const phoneNumber = s.string({ trim: true, min: 1, max: 32 });

/**
 * `phoneNumber` as a function, for a value that is not a net-event argument.
 *
 * `placeCall` is entered by the `CreateCall` export as well as by `phone:start`, the
 * number registry takes numbers from other resources, and `micacall` takes one from a
 * console argument. None of those has a tuple to declare, so they ask the same rule the
 * schema holds rather than keeping a second copy of it. `null` on refusal, since none of
 * them has anyone to throw at.
 */
export function phoneNumberFrom(raw: unknown): string | null {
  const outcome = phoneNumber['~standard'].validate(raw);
  return outcome instanceof Promise || outcome.issues ? null : outcome.value;
}

/**
 * A 0-100 level off the wire, clamped and rounded.
 *
 * Clamping rather than refusing an out-of-range value: the request is legitimate and only
 * the number is not, which is the same call `SetBatteryLevel` makes. What *is* refused is
 * anything that was never a level at all — `undefined`, a non-numeric string, an object,
 * `NaN` — and `Number()` alone is not enough for that, which is the part that bit:
 * `Number(null)` is `0` and `Number('')` is `0`, so a client sending nothing at all used to
 * produce a perfectly valid "0% battery" rather than a refusal. `s.number()` accepts only a
 * real number or a string that is entirely one, and the clamp runs on what passed.
 */
export const batteryLevel = s
  .number()
  .transform((value) => Math.max(0, Math.min(100, Math.round(value))));
