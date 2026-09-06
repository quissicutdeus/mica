// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { phoneNumberFrom } from './netGuard';
import { ok, fail, type ExportOutcome } from './exports';

/**
 * Numbers owned by a script rather than by a character.
 *
 * A resource registers a number, and a call placed to it reaches that resource's handler
 * instead of failing as unreachable. This is the registry and nothing else: `Phone.ts` asks
 * it one question, `publicApi.ts` publishes onto it, and no other module knows how a line
 * is stored or how its handler is invoked.
 *
 * **A player always wins.** `Phone.ts` resolves `getPlayerByPhone` first and only falls back
 * here on a miss, so a number that later becomes a real character's silently stops reaching
 * the script instead of intercepting them. Registration additionally refuses a number a
 * character already holds, but that check is a courtesy — the per-call ordering is the
 * guarantee, because phone numbers are issued by the framework and can change under us at
 * any time.
 */

/** What a handler may answer. `forward` re-enters the ordinary player call path. */
export type CallVerdict =
  { action: 'accept' } | { action: 'reject' } | { action: 'forward'; source: number };

/** What reaches a line's handler when somebody calls it. */
export interface IncomingLineCall {
  /** The caller's phone number. */
  from: string;
  /** The caller's server id. */
  source: number;
  /** The call this verdict answers. */
  callId: number;
}

export interface LineOptions {
  onCall: (call: IncomingLineCall) => CallVerdict | Promise<CallVerdict>;
  /** Defaults to true. A blockable line can be blocked like any other number. */
  blockable?: boolean;
}

export interface RegisteredLine {
  number: string;
  owner: string;
  blockable: boolean;
  onCall: LineOptions['onCall'];
}

const lines = new Map<string, RegisteredLine>();

/** Test seam, matching `__resetCalls` in `Phone.ts`. */
export const __resetRegistry = (): void => {
  lines.clear();
};

export const lookupLine = (number: string): RegisteredLine | undefined => lines.get(number);

/** Every line a resource owns. Used by the resource-stop sweep. */
export const linesOwnedBy = (owner: string): RegisteredLine[] =>
  [...lines.values()].filter((line) => line.owner === owner);

export function registerNumber(
  rawNumber: unknown,
  options: LineOptions,
  owner: string
): ExportOutcome {
  const number = phoneNumberFrom(rawNumber);
  if (!number) {
    return fail('invalid_args', 'A phone number is required.');
  }
  if (typeof options?.onCall !== 'function') {
    return fail('invalid_args', 'onCall must be a function.');
  }

  const held = lines.get(number);
  if (held && held.owner !== owner) {
    return fail('already_registered', `${held.owner} already holds that number.`);
  }

  if (FrameworkBridge.getPlayerByPhone(number)) {
    return fail('number_in_use', 'A character already holds that number.');
  }

  lines.set(number, {
    number,
    owner,
    blockable: options.blockable !== false,
    onCall: options.onCall
  });
  return ok();
}

export function unregisterNumber(rawNumber: unknown, owner: string): ExportOutcome {
  const number = phoneNumberFrom(rawNumber);
  if (!number) return fail('invalid_args', 'A phone number is required.');

  const held = lines.get(number);
  if (!held) return fail('invalid_args', 'Nothing holds that number.');
  if (held.owner !== owner) return fail('not_owner', 'That number belongs to another resource.');

  lines.delete(number);
  return ok();
}

/**
 * How long a line's handler gets before the call is treated as unanswered.
 *
 * Long enough for a script doing a database read, short enough that a caller is not left
 * ringing a dead line. A handler that overruns is answered as `reject`, which reaches the
 * caller as `failUnreachable` — so a broken integration is indistinguishable from a number
 * nobody holds, the same guarantee MICA-64 makes about a blocked call.
 */
export const HANDLER_TIMEOUT_MS = 5000;

const REJECT: CallVerdict = { action: 'reject' };

/** A verdict shaped the way this module promised, or null. */
const verdictFrom = (raw: unknown): CallVerdict | null => {
  if (!raw || typeof raw !== 'object') return null;
  const action = (raw as { action?: unknown }).action;
  if (action === 'accept' || action === 'reject') return { action };
  if (action === 'forward') {
    const source = (raw as { source?: unknown }).source;
    return typeof source === 'number' && Number.isInteger(source)
      ? { action: 'forward', source }
      : null;
  }
  return null;
};

/**
 * Ask a line what to do with a call. Never throws, never hangs.
 *
 * The handler belongs to another resource and is reached through a function ref, so all
 * three failure modes are somebody else's bug rather than ours: it can throw, it can reject,
 * and it can simply never come back. Each answers `reject`, because the alternative is a
 * caller whose phone rings forever.
 */
export async function askLine(line: RegisteredLine, call: IncomingLineCall): Promise<CallVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      Promise.resolve(line.onCall(call)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `[mica] line ${line.number} (${line.owner}) did not answer within ` +
              `${HANDLER_TIMEOUT_MS}ms; treating the call as unreachable.`
          );
          resolve(null);
        }, HANDLER_TIMEOUT_MS);
      })
    ]);
    return verdictFrom(verdict) ?? REJECT;
  } catch (error) {
    console.error(`[mica] line ${line.number} (${line.owner}) threw:`, error);
    return REJECT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
