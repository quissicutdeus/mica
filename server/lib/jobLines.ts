// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JobLine } from '@mica/shared/ownerConfig';
import { FrameworkBridge } from './FrameworkBridge';
import { jobLinesConvar, readJobLines } from './ownerConfig';
import { registerNumber, unregisterNumber, type CallVerdict } from './numberRegistry';

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

const holdsJob = (line: JobLine, job: { name: string; active: boolean; onDuty: boolean | null }) =>
  line.jobs.includes(job.name) &&
  job.active === true &&
  // `null` is a framework that cannot say (ESX without a boolean `job.onDuty`): holding the
  // active job counts, rather than nobody ever ringing on that server.
  (!line.requireDuty || job.onDuty !== false);

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
    if (jobs.some((job) => holdsJob(line, job))) staff.push(src);
  }
  return staff.sort((a, b) => a - b);
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
      }
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
