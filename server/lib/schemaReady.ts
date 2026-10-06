// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The gate every start-up job that reads the database waits behind (MICA-306): the outcome of
 * the first-start schema check, settled once per resource start.
 *
 * **Why this is its own module, with no imports.** The check itself (`schemaBootstrap.ts`)
 * needs `schemaSql.ts`, which needs `defineService.ts`, which needs `Repository.ts` — and
 * `Repository.ts` reaches `contentCipher.ts`, one of the jobs gated here. A gated module
 * importing the check directly closes that cycle, and `SchemaRepository extends Repository`
 * then evaluates before `Repository` exists ("Class extends value undefined"). So the jobs
 * import this, and `schemaBootstrap.ts` installs the check into it at import — a slot, the
 * pattern `ownerWidth.ts` uses for the same reason.
 *
 * **A slot nothing filled is loud, never a pass.** `services/Schema.ts` imports
 * `schemaBootstrap.ts`, so the real resource always fills it; if that import were ever lost,
 * `schemaReady` says so on the console instead of reporting a schema it never checked.
 */

/** Which schema a fresh database gets: qb's 50-wide `citizenid`, or ESX's and standalone's 60. */
export type SchemaShape = 'qb' | 'esx';

export type SchemaRefusal =
  | 'disabled'
  | 'framework-unknown'
  | 'owner-table-missing'
  | 'no-ddl-rights'
  | 'create-failed'
  | 'concurrent-create';

export type SchemaOutcome =
  /** Not fresh: nothing was done, and nothing is any different from before MICA-306. */
  | { kind: 'existing' }
  /** Fresh, and this server created every table and seeded the ledger. */
  | { kind: 'created'; shape: SchemaShape; tables: number }
  /** Fresh, but another server sharing the database created it first; this one waited. */
  | { kind: 'created-elsewhere' }
  /** The check itself could not be answered. Nothing was created; nothing is known. */
  | { kind: 'unknown'; error: string }
  /** Nothing more will be done this start. `message` is what was logged. */
  | { kind: 'refused'; reason: SchemaRefusal; message: string };

let check: (() => Promise<SchemaOutcome>) | null = null;
let ready: Promise<SchemaOutcome> | null = null;

/** Called once, by `schemaBootstrap.ts` at import. */
export const installSchemaCheck = (fn: () => Promise<SchemaOutcome>): void => {
  check = fn;
};

/** Whether `schemaBootstrap.ts` has filled the slot. For the test that proves the graph does. */
export const schemaCheckInstalled = (): boolean => check !== null;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const notInstalled = async (): Promise<SchemaOutcome> => {
  const error = 'the first-start schema check was never installed (schemaBootstrap.ts)';
  console.error(`[mica] ${error}; start-up jobs run without it.`);
  return { kind: 'unknown', error };
};

/**
 * The schema's state for this resource start, settled once. Started by its first caller and
 * shared by every one after it. Never rejects.
 */
export const schemaReady = (): Promise<SchemaOutcome> => {
  ready ??= (check ? check() : notInstalled())
    .catch((error: unknown): SchemaOutcome => {
      const detail = messageOf(error);
      console.error(`[mica] the first-start schema check failed: ${detail}`);
      return { kind: 'unknown', error: detail };
    })
    .then((outcome) => {
      settled = outcome;
      return outcome;
    });
  return ready;
};

/** The outcome once `schemaReady()` has settled; null while it is pending or not started. */
let settled: SchemaOutcome | null = null;

/**
 * The synchronous half of the gate, for a timer that fires on its own schedule rather than once
 * at start: true only once the check has settled on an outcome start-up jobs may run under.
 * Pending or refused is false — skip quietly and let the next tick ask again. It reads the
 * settled outcome and never starts or waits on the check itself.
 */
export const startupJobsMayRunNow = (): boolean => settled !== null && startupJobsMayRun(settled);

/**
 * Whether the start-up jobs that read the database should run. Every outcome but a refusal:
 * `unknown` included, because a check that could not read the database proves nothing about
 * the tables, and those jobs report their own failures exactly as they did before MICA-306.
 */
export const startupJobsMayRun = (outcome: SchemaOutcome): boolean => outcome.kind !== 'refused';

/**
 * Run a start-up job once the schema has settled, unless it was refused. Every start-up job
 * that reads the database goes through this, so none of them runs against tables that are
 * still being created — or that never will be.
 */
export const whenSchemaReady = (job: () => unknown): void => {
  void schemaReady()
    .then((outcome) => (startupJobsMayRun(outcome) ? job() : undefined))
    .catch((error: unknown) => {
      console.error('[mica] a start-up job failed:', error);
    });
};

/**
 * Test seam: settle `schemaReady` to `outcome` without asking the database, or forget it with
 * `null` so the next caller runs the check for real. Suites that drive a start hook directly
 * set `{ kind: 'existing' }`, so they neither wait a minute nor see the check's queries.
 */
export const __setSchemaReadyForTests = (outcome: SchemaOutcome | null): void => {
  ready = outcome ? Promise.resolve(outcome) : null;
  settled = outcome;
};
