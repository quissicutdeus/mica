// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JobLine } from '@mica/shared/ownerConfig';
import { buildDeepLink } from '@mica/shared/deepLink';
import type { FrameworkJob } from './framework/runtime';
import { FrameworkBridge } from './FrameworkBridge';
import { appEventChannel } from './appEvents';
import { jobLinesConvar, readJobLines } from './ownerConfig';
import {
  lookupLine,
  registerNumber,
  unregisterNumber,
  type CallVerdict,
  type IncomingLineMessage
} from './numberRegistry';

/**
 * Job lines from `mica_job_lines` (MICA-307): numbers micaOS answers itself by ringing every
 * eligible member of staff at once, so calling 911 or a mechanic needs no owner-written Lua.
 *
 * Each entry becomes an ordinary registry line owned by this resource, so a player holding the
 * number still wins, the resource-stop sweep still releases it, and `Phone.ts` sees nothing it
 * does not already see from a script answering `ring`. Staff are judged from the framework at
 * call time, never from anything a client sent.
 *
 * The convar is synced by its raw value: at start, at most every `SYNC_INTERVAL_MS` after, and
 * once more right before a call to a number nobody answers for (`refreshJobLines`), so a `set`
 * on a live server applies without a restart. A value naming a file is compared as that path,
 * so editing the file itself still takes a restart or a change to the value.
 */

/** How often the convar's raw value is compared, at most. */
export const SYNC_INTERVAL_MS = 5000;

/** Each line this module registered, by number, as the entry it was registered from. */
const held = new Map<string, JobLine>();

/** The raw value last synced, or null before the first sync. */
let syncedRaw: string | null = null;
let lastCheck = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const owner = (): string => GetCurrentResourceName();

/** Test seam: forget what was synced. Leaves the registry to `__resetRegistry`. */
export const __resetJobLines = (): void => {
  held.clear();
  syncedRaw = null;
  lastCheck = 0;
  if (timer) clearInterval(timer);
  timer = null;
};

/** The numbers this module holds right now, in the order they were registered. */
export const jobLineNumbers = (): string[] => [...held.keys()];

/**
 * The `mica_job_lines` entry registered under this number right now, or undefined (MICA-307).
 *
 * Held here *and* still this resource's in the registry: a number micaOS let go of, or one a
 * script holds, is not a config line whatever this map last said. The Jobs app's inbox asks
 * this before anything else, so a script's own line is never opened as a shared inbox.
 */
export const configLine = (number: string): JobLine | undefined => {
  const line = held.get(number);
  return line && lookupLine(number)?.owner === owner() ? line : undefined;
};

type JobState = Pick<FrameworkJob, 'name' | 'active' | 'onDuty'>;

const holdsJob = (line: JobLine, job: JobState) =>
  line.jobs.includes(job.name) &&
  job.active === true &&
  // `null` is a framework that cannot say (ESX without a boolean `job.onDuty`): holding the
  // active job counts, rather than nobody ever ringing on that server.
  (!line.requireDuty || job.onDuty !== false);

/**
 * Whether a player holding `jobs` is this line's staff: one of its jobs is their active job,
 * and, when the line requires duty, the framework does not say they are off it.
 *
 * The one definition. `staffFor` rings by it and the Jobs app's inbox opens by it (MICA-307),
 * so who a 911 call rings and who may read 911's texts can never disagree. `jobs` is the
 * framework's list, never a payload's.
 */
export const isLineStaff = (line: JobLine, jobs: readonly JobState[]): boolean =>
  jobs.some((job) => holdsJob(line, job));

/**
 * The connected players a line rings: holding one of its jobs as the active job, on duty when
 * the line requires it, never the caller, by ascending source. Every one of them, uncapped:
 * `maxRing` travels on the verdict as `max` and `Phone.ts` applies it after dropping the busy,
 * so ten busy officers with low server ids cannot hide two free ones.
 */
export function staffFor(line: JobLine, caller: number): number[] {
  const staff: number[] = [];
  for (const key of Object.keys(FrameworkBridge.getAllPlayers())) {
    const src = Number(key);
    if (!Number.isInteger(src) || src <= 0 || src === caller) continue;
    const player = FrameworkBridge.getPlayer(src);
    if (!player) continue;
    let jobs: ReturnType<typeof player.getJobs>;
    try {
      jobs = player.getJobs();
    } catch (error) {
      console.error(`[micaOS] mica_job_lines: could not read jobs for player ${src}:`, error);
      continue;
    }
    if (isLineStaff(line, jobs)) staff.push(src);
  }
  return staff.sort((a, b) => a - b);
}

/** The citizenids of a line's staff right now, but for the player on `except`. */
const staffCitizenIds = (line: JobLine, except: number): string[] =>
  staffFor(line, except)
    .map((src) => FrameworkBridge.getCitizenId(src))
    .filter((citizenid): citizenid is string => Boolean(citizenid));

/**
 * Tell a line's staff a thread moved (MICA-307), so every open inbox refetches: `line_message`
 * on the Jobs app, carrying references only. With `notify`, it also toasts and saves a
 * notification naming the line and the sender's number but never the text: the body is sealed
 * at rest (MICA-165), and a persisted notification holding it would undo that. Without it, the
 * push is silent: a staff reply to the other staff, or a player's further text in a thread
 * already waiting on an answer (`notifyIncoming`).
 *
 * Never throws: it runs after the write, and a push must never fail the write it follows.
 */
export function pushLineMessage(
  line: JobLine,
  conversationId: number,
  except: number,
  notify?: { from: string | null }
): void {
  try {
    const citizenids = staffCitizenIds(line, except);
    if (citizenids.length === 0) return;
    const name = line.label ?? line.number;
    const payload = { number: line.number, conversation_id: conversationId };
    appEventChannel('jobs').pushMany(
      citizenids,
      'line_message',
      payload,
      notify === undefined
        ? undefined
        : {
            notify: {
              type: 'info',
              title: `Text to ${name}`,
              message: `From ${notify.from ?? 'an unknown number'}`
            },
            kind: 'line_message',
            title: `Text to ${name}`,
            deepLink: buildDeepLink('jobs')
          }
    );
  } catch (error) {
    console.error(`[micaOS] mica_job_lines: could not tell ${line.number}'s staff:`, error);
  }
}

/**
 * Whether a thread was already waiting on an answer before this message: its newest live row
 * before `messageId` is the player's own. Read from the rows, never remembered, so a restart
 * cannot lose it.
 *
 * A slot rather than an import, for the reason `onLineReleased` gives in `numberRegistry.ts`:
 * the read needs the messages repository, which a service owns, and `lib/` must not import
 * `services/`. `services/Jobs.ts` fills it at import. Until it is filled every text notifies,
 * so a server that never loaded the reader errs towards staff hearing of a text.
 */
let wasAwaiting: (conversationId: number, messageId: number) => Promise<boolean> = async () =>
  false;

export const onLineThreadState = (
  read: (conversationId: number, messageId: number) => Promise<boolean>
): void => {
  wasAwaiting = read;
};

/**
 * A player texted a config line. Every staff member's inbox refetches; the toast and the saved
 * notification go out only when this text is what makes the thread wait on an answer — the
 * first text, or the first after a staff reply — so one player sending twenty texts to 911
 * notifies each officer once, not twenty times. A read that fails notifies, for the same reason
 * an unfilled slot does.
 */
export async function notifyIncoming(line: JobLine, message: IncomingLineMessage): Promise<void> {
  let quiet = false;
  try {
    quiet = await wasAwaiting(message.conversationId, message.messageId);
  } catch (error) {
    console.error(
      `[micaOS] mica_job_lines: could not read thread ${message.conversationId} on ${line.number}:`,
      error
    );
  }
  pushLineMessage(
    line,
    message.conversationId,
    message.source,
    quiet ? undefined : { from: message.from }
  );
}

const sameLine = (a: JobLine, b: JobLine): boolean =>
  a.number === b.number &&
  a.label === b.label &&
  a.requireDuty === b.requireDuty &&
  a.maxRing === b.maxRing &&
  a.blockable === b.blockable &&
  a.jobs.length === b.jobs.length &&
  a.jobs.every((job, index) => job === b.jobs[index]);

const show = (line: JobLine): string => JSON.stringify(line);

/** Register one entry. Logs a refusal loudly, naming the entry and the holder, and skips it. */
function register(line: JobLine): boolean {
  const result = registerNumber(
    line.number,
    {
      label: line.label ?? undefined,
      blockable: line.blockable,
      onCall: ({ source }): CallVerdict => {
        const sources = staffFor(line, source);
        return sources.length > 0
          ? { action: 'ring', sources, max: line.maxRing }
          : { action: 'reject' };
      },
      // The text is already in the player's thread; the staff hear of it here (MICA-307).
      onMessage: (message: IncomingLineMessage) => notifyIncoming(line, message)
    },
    owner(),
    { jobs: line.jobs }
  );
  if (!result.ok) {
    // `already_registered` names the resource that holds it; `number_in_use` says a character
    // does. Either way the owner reads why their line is not answering.
    console.error(`[micaOS] mica_job_lines: not registering ${show(line)}: ${result.message}`);
    return false;
  }
  return true;
}

/**
 * Bring the registry in line with `raw`: lines no longer listed are unregistered, new ones
 * registered, changed ones re-registered in place, and unchanged ones left alone.
 */
function applyJobLines(raw: string): void {
  const resolved = readJobLines(raw);
  if (resolved.problem) {
    console.error(`[micaOS] mica_job_lines: ${resolved.problem}. No job lines are registered.`);
  }
  for (const { entry, reason } of resolved.rejected) {
    console.error(`[micaOS] mica_job_lines: refusing ${entry}: ${reason}.`);
  }

  const wanted = new Map(resolved.value.map((line) => [line.number, line]));
  for (const [number, line] of held) {
    const next = wanted.get(number);
    if (next && sameLine(line, next)) continue;
    // A changed line is dropped too and registered again below. Synchronous, so no call can
    // land in between, and a re-registration that is now refused (a character took the
    // number) leaves nothing behind still answering with the old entry.
    held.delete(number);
    unregisterNumber(number, owner());
  }
  for (const line of resolved.value) {
    if (held.has(line.number)) continue;
    if (register(line)) held.set(line.number, line);
  }
}

/** Re-sync when the raw value changed since the last sync. Cheap when it has not. */
function syncIfChanged(): void {
  const raw = jobLinesConvar();
  if (raw === syncedRaw) return;
  syncedRaw = raw;
  applyJobLines(raw);
}

/**
 * Called by `Phone.ts` right before a call to a number nobody answers for: one convar read
 * and a string comparison, so the first call after a `set` reaches the new line.
 */
export function refreshJobLines(): void {
  lastCheck = Date.now();
  syncIfChanged();
}

/** The periodic check, at most once per `SYNC_INTERVAL_MS`. */
export function tickJobLines(now: number = Date.now()): void {
  if (now - lastCheck < SYNC_INTERVAL_MS) return;
  lastCheck = now;
  syncIfChanged();
}

/**
 * Register the configured lines and start watching the convar. Called once from the resource
 * start handler in `server.ts`, after which the start-up line says what is answering.
 */
export function startJobLines(): void {
  refreshJobLines();
  if (!timer && typeof setInterval === 'function') {
    timer = setInterval(() => tickJobLines(), SYNC_INTERVAL_MS);
  }
  const numbers = jobLineNumbers();
  console.log(
    numbers.length > 0
      ? `mica: job lines -> ${numbers.length} registered (${numbers.join(', ')})`
      : 'mica: job lines -> none registered'
  );
}
