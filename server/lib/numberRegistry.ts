// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { phoneNumberFrom } from './netGuard';
import { ok, fail, type ExportOutcome } from './exports';
import { LINE_LABEL_MAX, RING_MAX } from '@mica/shared/ownerConfig';
import { onResourceReleased } from './resourceStop';

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

/**
 * What a handler may answer. `forward` re-enters the ordinary player call path. `ring` rings
 * every listed player at once and the first to answer takes the call (MICA-307). The list is
 * deduped and holds at most `RING_LIST_MAX`; `Phone.ts` drops the caller, the busy and anyone
 * with no number, then rings the first `max` of the rest, never more than `RING_MAX`.
 */
export type CallVerdict =
  | { action: 'accept' }
  | { action: 'reject' }
  | { action: 'forward'; source: number }
  | { action: 'ring'; sources: number[]; max?: number };

export { RING_MAX };

/**
 * The longest `ring` list taken. Far above `RING_MAX` on purpose: the list is every candidate,
 * and who is actually rung is decided after the busy filter, so a list cut to 32 before it
 * would hide the free staff behind busy ones. A longer list is refused whole, not cut.
 */
export const RING_LIST_MAX = 256;

/** What reaches a line's handler when somebody calls it. */
export interface IncomingLineCall {
  /** The caller's phone number. */
  from: string;
  /** The caller's server id. */
  source: number;
  /** The call this verdict answers. */
  callId: number;
}

/**
 * What reaches a line's `onMessage` when a player texts it (MICA-275).
 *
 * The text is already written by the time this is called: it sits in the thread between the
 * player's phone and the line, the same thread `SendMessage` from this number writes into. To
 * answer, call `SendMessage(citizenid, { from: { number }, body })` with the line's number.
 * `citizenid` is here so that reply still lands when the player has gone offline.
 */
export interface IncomingLineMessage {
  /** The line's own number, the one that was texted. */
  to: string;
  /** The sender's phone number, or null when the framework has none for them. */
  from: string | null;
  /** The sender's server id. */
  source: number;
  /** The sender's citizenid, which `SendMessage` takes to reply. */
  citizenid: string;
  /** The text. Empty when the player sent only an attachment. */
  body: string;
  /** The thread the text is in, the same one a reply lands in. */
  conversationId: number;
  messageId: number;
}

export interface LineOptions {
  onCall: (call: IncomingLineCall) => CallVerdict | Promise<CallVerdict>;
  /**
   * Called when a player texts the number (MICA-275). Optional: a line without it still
   * receives texts into its thread, and nothing is told. Its return value is ignored, and a
   * throw or a rejection is logged: the player's send has already succeeded by then.
   */
  onMessage?: (message: IncomingLineMessage) => unknown;
  /**
   * Defaults to true. A player who blocks a blockable line's number gets no live push from its
   * texts, as for any other number (MICA-278). `false` delivers regardless, and only for texts
   * the owning resource sends: calls to a line are never subject to the caller's blocklist.
   */
  blockable?: boolean;
  /** Shown as the contact's name: 'LSPD Dispatch'. At most 40 characters after trimming. */
  label?: string;
  /**
   * The framework job this line belongs to ('police'), lower_snake_case, so the Jobs app
   * (MICA-228) can list a job's numbers under the job. A claim by the registering script,
   * not a check against the framework — a job the framework does not have simply lists
   * nowhere.
   */
  job?: string;
}

export interface RegisteredLine {
  number: string;
  owner: string;
  blockable: boolean;
  label: string | null;
  job: string | null;
  /**
   * Every job the line lists under in the Jobs app: `[job]` for a script's line, or the jobs a
   * `mica_job_lines` entry names, which may be several (MICA-307). `[]` for neither.
   */
  jobs: string[];
  onCall: LineOptions['onCall'];
  onMessage: LineOptions['onMessage'] | null;
}

export const LABEL_MAX = LINE_LABEL_MAX;

/**
 * What a line's number may look like (MICA-275): digits, optionally led by `+`, with the
 * separators people dial through — space, `-`, `.`, `(` and `)` — and at least one digit.
 *
 * Stricter than `phoneNumberFrom`, which only trims and caps the length, because a line's
 * number is also the key of its thread (`ext:<number>`, lowercased). Letters are what let a
 * line registered as "Downtown Cab" match another resource's name-only `SendMessage` thread,
 * and two case-variants of one name match each other. Nothing in this shape has a case, and
 * nothing a name-only sender produces fits it unless the name is itself a number.
 */
const LINE_NUMBER = /^\+?[\d ().-]*\d[\d ().-]*$/;
const JOB_KEY = /^[a-z][a-z0-9_]*$/;

const lines = new Map<string, RegisteredLine>();

/** Test seam, matching `__resetCalls` in `Phone.ts`. */
export const __resetRegistry = (): void => {
  lines.clear();
  lineReleased = () => {};
};

export const lookupLine = (number: string): RegisteredLine | undefined => lines.get(number);

/** Every line registered right now, by anyone. */
export const allLines = (): RegisteredLine[] => [...lines.values()];

/** Every line a resource owns. Used by the resource-stop sweep. */
export const linesOwnedBy = (owner: string): RegisteredLine[] =>
  [...lines.values()].filter((line) => line.owner === owner);

/** Every line registered under a job, for the Jobs app. `[]` for a job nobody claimed. */
export const linesForJob = (job: string): RegisteredLine[] =>
  [...lines.values()].filter((line) => line.jobs.includes(job));

/**
 * What only micaOS itself may set on a line: the job lines from `mica_job_lines` (MICA-307).
 * A fourth argument rather than a field on `LineOptions`, so the `RegisterNumber` export, which
 * passes three, cannot reach it.
 */
export interface InternalLineOptions {
  /** Lower_snake_case, already checked by the config parser. Replaces `[job]`. */
  jobs?: readonly string[];
}

export function registerNumber(
  rawNumber: unknown,
  options: LineOptions,
  owner: string,
  internal: InternalLineOptions = {}
): ExportOutcome {
  const number = phoneNumberFrom(rawNumber);
  if (!number) {
    return fail('invalid_args', 'A phone number is required.');
  }
  if (!LINE_NUMBER.test(number)) {
    return fail(
      'invalid_args',
      "A line's number is digits, with an optional leading '+' and spaces, '-', '.', '(' or ')'."
    );
  }
  if (typeof options?.onCall !== 'function') {
    return fail('invalid_args', 'onCall must be a function.');
  }
  if (options.onMessage !== undefined && typeof options.onMessage !== 'function') {
    return fail('invalid_args', 'onMessage must be a function.');
  }

  // Refused rather than truncated or dropped: a label cut short reads as a different name,
  // and a job silently dropped is a line that never appears where the script expected it.
  let label: string | null = null;
  if (options.label !== undefined) {
    if (typeof options.label !== 'string') {
      return fail('invalid_args', 'label must be a string.');
    }
    label = options.label.trim();
    if (label.length === 0) label = null;
    else if (label.length > LABEL_MAX) {
      return fail('invalid_args', `label must be at most ${LABEL_MAX} characters.`);
    }
  }
  let job: string | null = null;
  if (options.job !== undefined) {
    if (typeof options.job !== 'string' || !JOB_KEY.test(options.job)) {
      return fail('invalid_args', "job must be a lower_snake_case job name, like 'police'.");
    }
    job = options.job;
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
    label,
    job,
    jobs: internal.jobs ? [...internal.jobs] : job ? [job] : [],
    onCall: options.onCall,
    onMessage: options.onMessage ?? null
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

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * `ring`'s list, or null. A Lua sequence table crosses the export boundary as a JS array, so
 * an array is the one shape taken; anything else, an empty list, or a single entry that is not
 * a positive integer refuses the whole verdict — a list with a stray value in it is a bug in
 * the script, and ringing the rest would hide it. Deduped in first-seen order, and refused
 * whole when more than `RING_LIST_MAX` distinct sources remain.
 */
const ringSourcesFrom = (raw: unknown): number[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sources = new Set<number>();
  for (const source of raw) {
    if (!isPositiveInteger(source)) return null;
    sources.add(source);
  }
  return sources.size <= RING_LIST_MAX ? [...sources] : null;
};

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
  if (action === 'ring') {
    const sources = ringSourcesFrom((raw as { sources?: unknown }).sources);
    if (!sources) return null;
    // Optional; when given, a positive integer. `Phone.ts` holds it to `RING_MAX`.
    const max = (raw as { max?: unknown }).max;
    if (max === undefined) return { action: 'ring', sources };
    return isPositiveInteger(max) ? { action: 'ring', sources, max } : null;
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

/**
 * Tell a line a player texted it (MICA-275). Never throws, never waits.
 *
 * Fire-and-forget rather than awaited, unlike `askLine`: a call needs the handler's verdict
 * before anything can happen, but a text is already written and delivered to the thread, so
 * there is nothing for the player's send to wait on. A handler that throws, rejects or never
 * returns is somebody else's bug and is logged. Returns whether a handler was there to tell.
 */
export function tellLine(line: RegisteredLine, message: IncomingLineMessage): boolean {
  const handler = line.onMessage;
  if (!handler) return false;
  const report = (error: unknown) =>
    console.error(`[mica] line ${line.number} (${line.owner}) onMessage threw:`, error);
  try {
    Promise.resolve(handler(message)).catch(report);
  } catch (error) {
    report(error);
  }
  return true;
}

/**
 * Told when a line goes away, so live calls on it can be ended.
 *
 * A hook rather than a direct call because this module lives in `lib/` and the call state
 * lives in `services/Phone.ts`; importing the service from here would close the same runtime
 * cycle `lib/phoneNumbers.ts` documents avoiding. `Phone.ts` fills the slot at import time.
 */
let lineReleased: (number: string) => void = () => {};

export const onLineReleased = (fn: (number: string) => void): void => {
  lineReleased = fn;
};

/**
 * Drop every number a resource owns, and return them.
 *
 * Without this a stopped script leaves a number that swallows calls into a dead function
 * ref forever — the failure mode function refs trade against, and the reason the export
 * takes refs at all rather than resource+export-name strings.
 */
export function releaseResource(owner: string): string[] {
  const dropped = linesOwnedBy(owner).map((line) => line.number);
  for (const number of dropped) {
    lines.delete(number);
    lineReleased(number);
  }
  return dropped;
}

// Through `onResourceReleased`, so a forged `onResourceStop` cannot free another resource's
// number — or micaOS's own job lines, which `mica` owns — for the forger to take.
onResourceReleased((resource) => {
  const dropped = releaseResource(resource);
  if (dropped.length > 0) {
    console.log(`[mica] released ${dropped.length} number(s) held by ${resource}.`);
  }
});
