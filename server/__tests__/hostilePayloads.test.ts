// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FrameworkPlayer } from '../lib/FrameworkBridge';
import type { ColumnRule, ResolvedService } from '../lib/defineService';
import type { StandardSchemaV1 } from '@mica/shared/schema';
import {
  FIELDS_WITHOUT_A_WRONG_TYPE,
  RAW_ARGUMENTS_NOT_VARIED,
  shapeOf,
  synthesize,
  wrongTypes,
  type Described,
  type NotVariedArgument,
  type NotVariedField
} from './schemaShapes';
import { TEST_PHONE_ID } from './phoneStub';
/**
 * The server's own entry point, so the swept surface is exactly what a server loads: every
 * service and every lib module it imports, and nothing copied from it by hand. Imported after the
 * mocks below (Vitest hoists `vi.mock` and `vi.hoisted` above every import), so the `onNet`
 * capture sees each registration and the contracts are built by a recorded `s`. At import it
 * registers the public exports and an `onResourceStart` listener, and starts nothing.
 */
import '../server';
import { dispatcherFor } from '../lib/ServiceEndpoint';
import { declaredServices } from '../lib/defineService';
import { registeredCustomActions, serviceApps } from '../lib/services';
import { contractFor } from '@mica/shared/contract';
import { __resetRateLimits } from '../lib/rateLimit';
import { GENERIC_ERROR_KEY } from '../lib/errors';
import { dmPolicyForTests } from '../services/DirectMessages';
import { reactableTables } from '../lib/reactions';
import { REPORTABLE } from '../lib/moderation';
import { jobLineNumbers, refreshJobLines } from '../lib/jobLines';

/**
 * Every registered server action, sent the payloads a modified client would send (MICA-463).
 *
 * AGENTS.md §2.9: a registered `mica:server:*` event is reachable whether or not the app calls
 * it, and every field and row id in its payload is attacker-controlled. Until this file that was
 * tested service by service, so an action was swept only if its author remembered to. Here the
 * list of actions is whatever registered: the `onNet` capture below, as `reachability.test.ts`
 * takes it, split into the actions an endpoint dispatches and the raw handlers. A new action is
 * swept the moment it registers, and one this file cannot describe fails the pinned lists at the
 * bottom until somebody looks at it.
 *
 * **What a field is comes from the declarations, never from a list here.** A generic CRUD action
 * reads its columns, their types and widths off its `defineService` declaration
 * (`declaredServices`: `clientWritable`, `clientFilterable`, `columnRules`). A custom action reads
 * its contract's input schema, which `schemaShapes.ts` records as the contracts are evaluated.
 *
 * **The `Database` is mocked, deliberately, rather than run under `pnpm test:endpoints`.** That
 * harness's flows are hand-written and hand-counted (`FLOW_CHECKS` in `scripts/test-endpoints.js`),
 * so a generated sweep has no place in it without changing the script; and most of these oracles
 * are "refused before any SQL", which a mock that records every statement answers exactly. The one
 * case a mock answers only weakly is another citizen's row id: here the database is a stand-in
 * where the caller owns row and account `OWNED_ID` and every row the stolen id names is somebody
 * else's (`world.mode = 'mixed'`), and the check is textual — a write that names the stolen id
 * binds the caller's citizenid in its `WHERE`. Whether that predicate then matches no row is what
 * real SQL would show, and the per-action matrix that would show it is MICA-464's.
 *
 * **The oracle is per case, not one blanket "zero writes".** See `refused` and `stripped` below;
 * each case's name says which it is held to.
 */

const h = vi.hoisted(() => {
  const CALLER_SRC = 46301;
  const CID_A = 'CIDA0463';
  const CID_B = 'CIDB0463';
  const CALLER_PHONE = '555-0463';
  const HOSTILE_ID = 424242;
  /** The caller's own row, and their own account, in the `owned` and `mixed` worlds. */
  const OWNED_ID = 4630;
  // `TEST_PHONE_ID` from `phoneStub.ts`, which a hoisted block cannot import; pinned equal below.
  const CALLER_DEVICE = '0123456789abcdef0123456789abcdef';

  /** `owned`: a read the stand-in answered with the caller's own row (`OWNED_ID`). */
  type Statement = { via: string; sql: string; params: unknown[]; owned?: boolean };
  const writes: Statement[] = [];
  const reads: Statement[] = [];
  const effects: { via: string; args: unknown[] }[] = [];
  /**
   * What the stand-in database holds.
   *
   * - `empty`: nothing.
   * - `hostile`: every row belongs to somebody else, and the caller owns nothing.
   * - `owned`: the caller owns row `OWNED_ID`, so an update has a row to write to.
   * - `mixed`: both at once. A read that names the caller — their citizenid, phone, device or
   *   `OWNED_ID` — finds the caller's row; one that names `HOSTILE_ID` finds `CID_B`'s; one that
   *   names both finds nothing, because the caller's predicate excludes the other citizen's row.
   *   So a handler that resolves the caller's own account first gets one, and goes on to meet
   *   the stolen id.
   */
  const world = { mode: 'empty' as 'empty' | 'hostile' | 'owned' | 'mixed' };

  const flat = (params: unknown): unknown[] =>
    Array.isArray(params) ? params.flatMap((p) => (Array.isArray(p) ? flat(p) : [p])) : [params];
  const namesCaller = (params: unknown[]): boolean =>
    flat(params).some((p) => p === CID_A || p === CALLER_PHONE || p === CALLER_DEVICE);
  const namesOwned = (params: unknown[]): boolean =>
    namesCaller(params) || flat(params).some((p) => p === OWNED_ID || p === String(OWNED_ID));
  const namesHostile = (params: unknown[]): boolean =>
    flat(params).some((p) => p === HOSTILE_ID || p === String(HOSTILE_ID));
  /** Leading comments skipped, so `/* audit *\/ UPDATE …` still counts as the write it is. */
  const verbOf = (sql: string): string =>
    (
      sql.replace(/^(\s|\/\*[\s\S]*?\*\/|--[^\n]*(\n|$)|#[^\n]*(\n|$))*/, '').match(/^\w+/)?.[0] ??
      ''
    ).toUpperCase();
  const isWrite = (sql: string): boolean =>
    ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE'].includes(
      verbOf(sql)
    );

  /** Every id a row carries, so a handler following one to the next stays in the same world. */
  const ids = (id: number) => ({
    account_id: id,
    post_id: id,
    conversation_id: id,
    profile_id: id,
    match_id: id,
    listing_id: id,
    target_id: id
  });

  /** Everything in the hostile world belongs to somebody else. */
  const hostileRow = () => ({
    ...ids(HOSTILE_ID),
    id: HOSTILE_ID,
    citizenid: CID_B,
    owner: CID_B,
    sender: CID_B,
    author: CID_B,
    status: 'active',
    device_id: 'b'.repeat(32),
    phone_number: '555-0999',
    number: '555-0999',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const ownedRow = () => ({
    ...hostileRow(),
    ...ids(OWNED_ID),
    id: OWNED_ID,
    citizenid: CID_A,
    owner: CID_A,
    sender: CID_A,
    author: CID_A,
    device_id: CALLER_DEVICE,
    phone_number: CALLER_PHONE,
    number: CALLER_PHONE
  });

  /**
   * A third citizen sharing the caller's rows: a list read about the caller's own thread finds
   * them beside the caller, so a conversation is not empty. Never the stolen id's owner.
   */
  const peerRow = () => ({
    ...ownedRow(),
    id: OWNED_ID + 1,
    citizenid: 'CIDC0463',
    owner: 'CIDC0463',
    sender: 'CIDC0463',
    author: 'CIDC0463',
    device_id: 'c'.repeat(32),
    phone_number: '555-0464',
    number: '555-0464'
  });

  const read = (via: string, sql: string, params: unknown[] = []) => {
    if (isWrite(sql)) {
      writes.push({ via, sql, params });
      return null;
    }
    const answer = ((): Record<string, unknown> | null => {
      if (world.mode === 'hostile') return namesCaller(params) ? null : hostileRow();
      if (world.mode === 'owned') return namesCaller(params) ? ownedRow() : null;
      if (world.mode === 'mixed') {
        const hostile = namesHostile(params);
        const owned = namesOwned(params);
        if (hostile) return owned ? null : hostileRow();
        return owned ? ownedRow() : null;
      }
      return null;
    })();
    reads.push({ via, sql, params, owned: answer?.id === OWNED_ID });
    return answer;
  };

  /** A scalar read answers the column it selected: an id, an owner, or a count. */
  const scalarOf = (sql: string, row: Record<string, unknown>): unknown => {
    if (/^\s*SELECT\s+COUNT\s*\(/i.test(sql)) return 1;
    const column = sql.match(/^\s*SELECT\s+(?:DISTINCT\s+)?`?(\w+)`?/i)?.[1];
    return column !== undefined && column in row ? row[column] : row.id;
  };

  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const row = read('query', sql, params);
      if (!row) return [];
      // A list about the caller's own rows, read by the row rather than by the caller, has the
      // third citizen in it too: the members of the caller's thread.
      const byRowOnly = world.mode === 'mixed' && row.id === OWNED_ID && !namesCaller(params);
      return byRowOnly ? [row, peerRow()] : [row];
    }),
    single: vi.fn(async (sql: string, params: unknown[] = []) => read('single', sql, params)),
    scalar: vi.fn(async (sql: string, params: unknown[] = []) => {
      const row = read('scalar', sql, params);
      return row ? scalarOf(sql, row) : null;
    }),
    insert: vi.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ via: 'insert', sql, params });
      return 1;
    }),
    update: vi.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ via: 'update', sql, params });
      return true;
    }),
    transaction: vi.fn(async (queries: { query: string; params?: unknown[] }[]) => {
      for (const q of queries)
        writes.push({ via: 'transaction', sql: q.query, params: q.params ?? [] });
      return true;
    })
  };

  const effect =
    <R>(via: string, answer: R) =>
    (...args: unknown[]): R => {
      effects.push({ via, args });
      return answer;
    };

  const player = {
    citizenid: CID_A,
    source: CALLER_SRC,
    phone: CALLER_PHONE,
    getMoney: () => 1_000_000,
    removeMoney: effect('player.removeMoney', true),
    addMoney: effect('player.addMoney', true),
    setMeta: effect('player.setMeta', undefined),
    removeItem: effect('player.removeItem', true),
    setPhone: effect('player.setPhone', true),
    // On duty in the job the sweep's one `mica_job_lines` entry answers for, so a job line's inbox
    // opens to the caller and a stolen thread id is judged by the line, not refused at the door.
    getJobs: () => [
      {
        name: 'police',
        label: 'Police',
        grade: 0,
        gradeLabel: '0',
        salary: 0,
        onDuty: true,
        isBoss: false,
        active: true
      }
    ],
    setActiveJob: effect('player.setActiveJob', false),
    setDuty: effect('player.setDuty', false),
    rawPlayer: {}
  };

  /** What `guardNetEvent` was handed and answered, so a raw handler's refusal is attributable. */
  const guard = {
    discovering: false,
    calls: [] as { service: string; action: string; schema: unknown }[],
    passed: [] as boolean[]
  };

  const handlers = new Map<string, Function[]>();
  (globalThis as any).onNet = (event: string, handler: Function) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  };

  return {
    CALLER_SRC,
    CID_A,
    CID_B,
    CALLER_PHONE,
    CALLER_DEVICE,
    HOSTILE_ID,
    OWNED_ID,
    verbOf,
    db,
    writes,
    reads,
    effects,
    world,
    player,
    handlers,
    guard,
    flat,
    effect,
    reset: () => {
      writes.length = 0;
      reads.length = 0;
      effects.length = 0;
      guard.calls.length = 0;
      guard.passed.length = 0;
      world.mode = 'empty';
    }
  };
});

vi.mock('../lib/Database', () => ({ Database: h.db }));

vi.mock('../lib/FrameworkBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/FrameworkBridge')>();
  const stub: Record<string | symbol, unknown> = {
    getPlayer: (src: number) => (src === h.CALLER_SRC ? h.player : null),
    getCitizenId: (src: number) => (src === h.CALLER_SRC ? h.CID_A : null),
    getPlayerPhone: (src: number) => (src === h.CALLER_SRC ? h.CALLER_PHONE : null),
    getAllPlayers: () => ({}),
    onlineSources: () => [],
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: () => new Map(),
    getPlayerByPhone: () => null,
    findOfflineByCitizenId: async () => null,
    findOfflineByCitizenIds: async () => new Map(),
    findOfflineByPhone: async () => null,
    isSyntheticAdmin: () => false,
    ownerTable: () => null,
    jobSupport: () => ({ multiJob: false, duty: false, via: 'hostilePayloads.test' }),
    countItem: () => 1,
    removeInventoryItem: h.effect('removeInventoryItem', true),
    registerUsableItem: () => {},
    rememberSource: () => {},
    forgetSource: () => {},
    logOutSource: () => {}
  };
  // A method added to the bridge later answers `undefined` rather than throwing "not a function",
  // which the endpoint would answer generically and a refusal check would read as a pass.
  const FrameworkBridge = new Proxy(stub, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn()))
  });
  return { ...actual, FrameworkBridge };
});

/**
 * Every raw handler hands `guardNetEvent` its tuple before its first `await`. Recorded here, so the
 * sweep can read each one's declared arguments and see whether a refusal came from the guard. While
 * `discovering`, nothing is checked and the handler is told no, so finding a tuple runs nothing.
 */
vi.mock('../lib/netGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/netGuard')>();
  const guardNetEvent: typeof actual.guardNetEvent = (service, action, schema, args) => {
    h.guard.calls.push({ service, action, schema });
    if (h.guard.discovering) return null;
    const result = actual.guardNetEvent(service, action, schema, args);
    h.guard.passed.push(result !== null);
    return result;
  };
  return { ...actual, guardNetEvent };
});

/**
 * The recorder goes on before anything evaluates a contract: the schema module is handed to the
 * contracts through this factory, which wraps `s` in place first. The module is the real one —
 * same objects, same `SchemaError` — so nothing it validates behaves differently.
 */
vi.mock('@mica/shared/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mica/shared/schema')>();
  const { recordSchemaShapes } = await import('./schemaShapes');
  recordSchemaShapes(actual.s);
  return actual;
});

type Reply = { error?: unknown; key?: unknown; params?: Record<string, unknown> } & Record<
  string,
  unknown
>;

interface Outcome {
  replies: Reply[];
  writes: typeof h.writes;
  reads: typeof h.reads;
  effects: typeof h.effects;
  pushes: unknown[][];
  logged: unknown[][];
}

/* ─── The registered surface ─────────────────────────────────────────────────────────────── */

const PREFIX = 'mica:server:';
const GENERIC = new Set(['get', 'create', 'update', 'delete']);
const custom = new Set(registeredCustomActions());

interface Action {
  service: string;
  action: string;
  key: string;
}

const endpointActions: Action[] = [];
const rawEvents: string[] = [];
const foreignEvents: string[] = [];
for (const event of [...h.handlers.keys()].toSorted()) {
  if (!event.startsWith(PREFIX)) {
    foreignEvents.push(event);
    continue;
  }
  const rest = event.slice(PREFIX.length);
  const split = rest.indexOf(':');
  const service = rest.slice(0, split);
  const action = rest.slice(split + 1);
  if (dispatcherFor(service, action)) endpointActions.push({ service, action, key: rest });
  else rawEvents.push(event);
}

const genericActions = endpointActions.filter((a) => GENERIC.has(a.action) && !custom.has(a.key));
const customActions = endpointActions.filter((a) => custom.has(a.key));

const resolvedFor = (service: string): ResolvedService | undefined =>
  declaredServices.find((r) => r.id === service);

/** Every table a reply must never name: each declared one, its children, and the audit ledger. */
const TABLES = [
  ...new Set([
    ...declaredServices.flatMap((r) => [r.table, ...r.childTables.map((c) => c.name)]),
    'mica_audit_log'
  ])
];
const LEAK = new RegExp(
  `\\b(${TABLES.join('|')})\\b|\\bmica_[a-z0-9_]+|\\b(SELECT|INSERT INTO|DELETE FROM|ER_[A-Z_]+|sqlMessage|errno)\\b`
);

/* ─── Driving one request ────────────────────────────────────────────────────────────────── */

/**
 * One job line, parsed and registered by the real `mica_job_lines` path, so the Jobs app's inbox
 * actions have a line the caller is staff of. Every other convar answers its default.
 */
const JOB_LINES = '[{"number":"555-0911","label":"Dispatch","jobs":["police"]}]';
const convar = (name: string, fallback: string): string =>
  name === 'mica_job_lines' ? JOB_LINES : fallback;
(globalThis as any).GetConvar = convar;
refreshJobLines();

let logged: unknown[][] = [];
let pushes: unknown[][] = [];

beforeEach(() => {
  h.reset();
  __resetRateLimits();
  logged = [];
  pushes = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (globalThis as any).emitNet = (...args: unknown[]) => {
    pushes.push(args);
  };
  (globalThis as any).source = h.CALLER_SRC;
  (globalThis as any).GetConvar = convar;
  (globalThis as any).GetConvarInt = (_n: string, fallback: number) => fallback;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const ANSWER_WITHIN_MS = 4000;

/** One request through the endpoint's own dispatch, the body the net event runs. */
async function send(
  { service, action }: Action,
  data: unknown,
  mode: 'empty' | 'hostile' | 'owned' | 'mixed' = 'empty'
): Promise<Outcome> {
  const dispatch = dispatcherFor(service, action);
  if (!dispatch) throw new Error(`${service}:${action} has no dispatcher`);
  h.world.mode = mode;
  const replies: Reply[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    dispatch({
      src: h.CALLER_SRC,
      cbId: 1,
      data,
      rawDevice: undefined,
      lookup: (src: number) =>
        src === h.CALLER_SRC ? (h.player as unknown as FrameworkPlayer) : null,
      reply: (result: unknown) => replies.push(result as Reply)
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${service}:${action} did not finish within ${ANSWER_WITHIN_MS} ms`)),
        ANSWER_WITHIN_MS
      );
    })
  ]).finally(() => clearTimeout(timer));
  await settle();
  return {
    replies,
    writes: [...h.writes],
    reads: [...h.reads],
    effects: [...h.effects],
    pushes: [...pushes],
    logged: [...logged]
  };
}

/** The refusals that happen before validation, and so say nothing about a payload. */
const PRE_VALIDATION_KEYS = new Set([
  'server.rateLimited',
  'server.notAuthenticated',
  'server.device.unsupported',
  'server.endpoint.appDisabled',
  'server.phone.notHeld'
]);

/** Every answer, whatever the case: at most one reply, and nothing in it names storage. */
function expectAnsweredSafely(outcome: Outcome): void {
  expect(outcome.replies.length, 'replies').toBeLessThanOrEqual(1);
  for (const reply of outcome.replies) {
    expect(JSON.stringify(reply) ?? '', 'reply names storage').not.toMatch(LEAK);
  }
  expect(Object.keys(Object.prototype), 'Object.prototype polluted').toEqual([]);
  expect(({} as Record<string, unknown>).polluted, 'Object.prototype polluted').toBeUndefined();
}

/**
 * **Refused.** Exactly one reply, an error a player may read (not the generic answer, which is
 * what a stub gap or a crash looks like), attributed to the field that was broken, and nothing
 * written, pushed, logged or moved.
 */
function expectRefused(outcome: Outcome, field: string | null): void {
  // What came back, in every failure message, so a red run is the finding table: the answer, and
  // whether it wrote, moved, pushed or logged.
  const seen =
    `\n  reply: ${JSON.stringify(outcome.replies)}` +
    `\n  writes: ${outcome.writes.length}${outcome.writes[0] ? ` — ${outcome.writes[0].sql.replace(/\s+/g, ' ').slice(0, 160)} ${JSON.stringify(outcome.writes[0].params)}` : ''}` +
    `\n  effects: ${JSON.stringify(outcome.effects)}, pushes: ${outcome.pushes.length}` +
    `\n  logged: ${outcome.logged.map((line) => String(line.join(' ')).split('\n')[0]).join(' | ')}`;
  expectAnsweredSafely(outcome);
  expect(outcome.replies, `exactly one reply — none means it was accepted${seen}`).toHaveLength(1);
  const reply = outcome.replies[0]!;
  expect(typeof reply.error, `answered without an error, so accepted${seen}`).toBe('string');
  expect(reply.key, `refused before validation, so this proves nothing${seen}`).not.toSatisfy(
    (key) => PRE_VALIDATION_KEYS.has(String(key))
  );
  expect(reply.key, `answered generically, not refused${seen}`).not.toBe(GENERIC_ERROR_KEY);
  if (field !== null) {
    const message = String(reply.error);
    const params = reply.params ?? {};
    const named =
      message === `${field}` ||
      message.startsWith(`${field} `) ||
      message.startsWith(`${field}.`) ||
      message.startsWith(`${field}[`) ||
      message.startsWith(`${field}:`) ||
      message.startsWith(`'${field}'`) ||
      params.field === field ||
      params.column === field;
    expect(named, `refused, but not for '${field}'${seen}`).toBe(true);
  }
  expect(outcome.writes, `a refused request wrote${seen}`).toEqual([]);
  expect(outcome.effects, `a refused request moved something${seen}`).toEqual([]);
  expect(outcome.pushes, `a refused request pushed${seen}`).toEqual([]);
  expect(outcome.logged, `a refused request logged an error${seen}`).toEqual([]);
}

/** Smuggled beside a valid payload: none of these may reach a statement. */
const SMUGGLED = {
  evil_column_463: 'smuggled-463',
  citizenid: h.CID_B,
  id: 999_463,
  status: 'smuggled-status-463',
  device_id: 'smuggled-device-463',
  created_at: '2000-01-01 00:00:00',
  updated_at: '2000-01-02 00:00:00'
};
const SMUGGLED_VALUES = Object.values(SMUGGLED);

/** Own keys a decoder may hand over as data. `JSON.parse` makes them own keys, as msgpack does. */
const PROTO_JSON =
  '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}';
const protoKeys = (): Record<string, unknown> => JSON.parse(PROTO_JSON);
const withProtoKeys = (base: Record<string, unknown>): Record<string, unknown> =>
  Object.assign(protoKeys(), base);

/**
 * **Stripped.** The write goes ahead — the payload was valid apart from the extras — and no
 * statement names an extra key or binds an extra value.
 */
function expectStripped(outcome: Outcome, mustWrite: boolean): void {
  expectAnsweredSafely(outcome);
  if (mustWrite)
    expect(outcome.writes.length, 'positive twin: the valid part wrote').toBeGreaterThan(0);
  for (const statement of [...outcome.writes, ...outcome.reads]) {
    expect(statement.sql, 'a statement names a smuggled key').not.toMatch(
      /evil_column_463|__proto__|\bprototype\b|\bconstructor\b|polluted/
    );
    const bound = h.flat(statement.params);
    for (const value of SMUGGLED_VALUES) {
      expect(
        bound,
        `a statement binds the smuggled ${String(value)}: ${statement.sql}`
      ).not.toContain(value);
    }
  }
}

/**
 * **Not another citizen's row.** In the hostile world every row belongs to somebody else. Any
 * write that names the stolen id must bind the caller's citizenid beside it — the ownership
 * predicate §2.9 requires — and a device id or phone number alone does not count (MICA-438).
 */
function expectNoForeignWrite(outcome: Outcome, stolen: unknown = h.HOSTILE_ID): void {
  expectAnsweredSafely(outcome);
  const key = callerKeysOf(outcome);
  for (const write of outcome.writes) {
    if (!statementNames(write, stolen)) continue;
    const verb = h.verbOf(write.sql);
    const scoped =
      verb === 'UPDATE' || verb === 'DELETE' ? whereParams(write) : h.flat(write.params);
    expect(
      scoped.some(key),
      verb === 'UPDATE' || verb === 'DELETE'
        ? `writes another citizen's row with no caller key in its WHERE: ${write.sql} ${JSON.stringify(write.params)}`
        : // An INSERT has no WHERE: the row it makes is the caller's, so it carries their key. A
          // REPLACE or an upsert onto the stolen id is held to the same, which is all text can say;
          // an INSERT that stamps the citizenid beside a stolen *actor* is the twin's to catch.
          `writes a row naming another citizen's id without the caller's key: ${write.sql} ${JSON.stringify(write.params)}`
    ).toBe(true);
  }
  expect(outcome.effects, "another citizen's row moved money or items").toEqual([]);
}

/** The caller's own identity on the wire: citizenid, phone number, device. */
const namesCitizen = (bound: unknown[]): boolean =>
  bound.some((value) => value === h.CID_A || value === h.CALLER_PHONE || value === h.CALLER_DEVICE);

/**
 * What counts as the caller's ownership in one request's statements: their citizenid always, and
 * `OWNED_ID` — their own account or profile — only once a read in the same request named their
 * citizenid, phone or device and either bound `OWNED_ID` beside it (`ownedAccount` asking "is
 * this account the citizen's?") or was answered with it (`liveProfileOf` looking the citizen's
 * profile up). An `OWNED_ID` that came straight from the payload, with no such read, is just a
 * number the client sent, and counts for nothing (Crosshair, MICA-463 re-check). The residual:
 * this stand-in answers every read naming the citizen with the same row, so a handler that
 * dropped its check but happened to read something else by citizenid would still earn it.
 */
function callerKeysOf(outcome: Outcome): (value: unknown) => boolean {
  const earned = outcome.reads.some((read) => {
    const bound = h.flat(read.params);
    if (!namesCitizen(bound)) return false;
    // Asked about it beside the citizen (`ownedAccount`), or handed it back from a read by the
    // citizen alone (`liveProfileOf`): either way the id came from the citizen, not the payload.
    return bound.includes(h.OWNED_ID) || bound.includes(String(h.OWNED_ID)) || read.owned === true;
  });
  return (value) =>
    value === h.CID_A || (earned && (value === h.OWNED_ID || value === String(h.OWNED_ID)));
}

/**
 * Whether the ownership question was asked about the stolen id: a read bound it beside a caller
 * key, or an UPDATE or DELETE carried it in a `WHERE` beside one. An INSERT does not count — one
 * that stamps the citizenid beside a stolen account id is exactly the impersonation this asks
 * about, and it binds both.
 */
function ownershipAsked(outcome: Outcome, stolen: unknown): boolean {
  const key = callerKeysOf(outcome);
  const names = (bound: unknown[]) => bound.includes(stolen) || bound.includes(String(stolen));
  const ownedKey = (value: unknown) => value !== h.CID_A && key(value);
  return (
    outcome.reads.some((read) => names(h.flat(read.params)) && h.flat(read.params).some(key)) ||
    outcome.writes.some((write) => {
      const verb = h.verbOf(write.sql);
      if (verb === 'UPDATE' || verb === 'DELETE') {
        const where = whereParams(write);
        return names(where) && where.some(key);
      }
      // An INSERT asks nothing by binding the citizenid — one that stamps it beside a stolen
      // account id is the impersonation itself. It counts only when it binds the caller's own
      // account, earned above: the row is made *as* the caller, about the stolen one.
      const bound = h.flat(write.params);
      return names(bound) && bound.some(ownedKey);
    })
  );
}

/**
 * The twin's other two answers. The handler refused in words a player may read after the stolen
 * id reached it — its ownership check ran, in code rather than SQL (`isLiveMemberOn`, a
 * `row.citizenid !== citizenid`) — or it declined with `false`/nothing and no write names the id.
 */
function refusedAfterReaching(outcome: Outcome, stolen: unknown): boolean {
  const reply = outcome.replies[0];
  if (reply && typeof reply.error === 'string') return reply.key !== GENERIC_ERROR_KEY;
  const declined =
    reply === undefined || (reply as unknown) === false || (reply as unknown) === null;
  return declined && !outcome.writes.some((write) => statementNames(write, stolen));
}

/** Whether a statement names a value: bound as a parameter, or written into the SQL itself. */
function statementNames(statement: { sql: string; params: unknown[] }, value: unknown): boolean {
  const bound = h.flat(statement.params);
  if (bound.includes(value) || bound.includes(String(value))) return true;
  return new RegExp(
    `(^|[^\\w'"])${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w'"])`
  ).test(statement.sql);
}

/**
 * The parameters bound after a statement's first `WHERE` — its predicate, not its `SET`. Counted by
 * placeholders, so `UPDATE t SET citizenid = ? WHERE id = ?` with the caller's citizenid in the
 * `SET` is a takeover, not an ownership check.
 */
function whereParams(statement: { sql: string; params: unknown[] }): unknown[] {
  const where = statement.sql.search(/\bWHERE\b/i);
  if (where < 0) return [];
  const before = (statement.sql.slice(0, where).match(/\?/g) ?? []).length;
  return h.flat(statement.params).slice(before);
}

/**
 * The positive twin of `expectNoForeignWrite`: the stolen id did reach a statement, and that
 * statement bound the caller's citizenid beside it. Without it, a refusal for some other reason
 * would pass as an ownership check.
 */
function expectOwnershipAsked(outcome: Outcome): void {
  const asked = [...outcome.reads, ...outcome.writes].some((statement) => {
    const bound = h.flat(statement.params);
    return bound.includes(h.HOSTILE_ID) && bound.includes(h.CID_A);
  });
  expect(asked, "positive twin: a statement named the id and the caller's citizenid together").toBe(
    true
  );
}

/**
 * The twin for a custom action, whose handler is its own and may reach ownership through a
 * derived id (a profile, an account) rather than binding the citizenid beside the stolen one, or
 * may be a public read that rightly answers with somebody else's row. What it must not do is
 * crash: a generic answer with an error logged is what a stub gap looks like, and the write check
 * above would read that as a pass. So the handler ran to an answer of its own.
 */
function expectRanToItsOwnAnswer(outcome: Outcome): void {
  expect(outcome.logged, 'the handler crashed, so this proves nothing').toEqual([]);
  expect(outcome.replies[0]?.key, 'answered generically').not.toBe(GENERIC_ERROR_KEY);
}

/* ─── Generic CRUD: fields from the declaration ──────────────────────────────────────────── */

const TEXT_TYPES = new Set(['string', 'text', 'mediumtext', 'json']);

/** A value the column takes, or null when the declaration allows nothing this can build. */
function validFor(rule: ColumnRule): unknown {
  const candidates: unknown[] = (() => {
    switch (rule.type) {
      case 'enum':
        return [...(rule.values ?? [])];
      case 'int':
      case 'float':
        return [1];
      case 'bool':
        return [true];
      case 'json':
        return ['{}'];
      case 'string':
      case 'text':
      case 'mediumtext':
        return ['a', '555-0100', 'https://example.com/a.png', 'data:image/png;base64,AAAA'];
      default:
        return [];
    }
  })();
  return (
    candidates.find(
      (value) =>
        typeof value !== 'string' ||
        ((rule.maxLength === null || value.length <= rule.maxLength) &&
          (!rule.accepts || rule.accepts(value)))
    ) ?? null
  );
}

/** Scalars of the wrong type for a column: the values `typeof` alone would tell apart. */
function wrongScalars(rule: ColumnRule): { label: string; value: unknown }[] {
  switch (rule.type) {
    case 'string':
    case 'text':
    case 'mediumtext':
      return [
        { label: 'a number', value: 42 },
        { label: 'a boolean', value: true }
      ];
    case 'int':
    case 'float':
      return [
        { label: 'text', value: 'not-a-number' },
        { label: 'a boolean', value: true }
      ];
    case 'bool':
      // `1` too: oxmysql hands a `TINYINT(1)` back as a boolean, so no caller sends `0`/`1`.
      return [
        { label: 'text', value: 'not-a-boolean' },
        { label: 'a number', value: 1 }
      ];
    case 'enum':
      return [{ label: 'a number', value: 42 }];
    default:
      return [];
  }
}

interface Case {
  name: string;
  run: () => Promise<void>;
}

const genericCases: Case[] = [];
const genericUncovered: string[] = [];
/** Client-writable columns whose type has no wrong scalar to send (`wrongScalars`). */
const columnsWithoutAScalarCase: string[] = [];

for (const action of genericActions) {
  const resolved = resolvedFor(action.service);
  if (!resolved) {
    genericUncovered.push(`${action.key}: no defineService declaration to read columns from`);
    continue;
  }
  const label = (what: string) => `${action.key} — ${what}`;
  const writable = resolved.clientWritable;
  const rules = resolved.columnRules;
  const baselineColumn = writable.find((c) => rules[c] && validFor(rules[c]!) !== null);
  const baseline: Record<string, unknown> | null = baselineColumn
    ? { [baselineColumn]: validFor(rules[baselineColumn]!) }
    : null;
  const withId = (body: Record<string, unknown>) =>
    action.action === 'update' ? { id: 1, ...body } : body;
  // An update is sent where the caller owns row 1, so that a payload it accepts reaches the
  // UPDATE rather than stopping at a read that found nothing to change.
  const sendWrite = (data: unknown) =>
    send(action, data, action.action === 'update' ? 'owned' : 'empty');

  if (action.action === 'create' || action.action === 'update') {
    const what = action.action;
    genericCases.push(
      {
        name: label('missing payload is refused'),
        run: async () => expectRefused(await sendWrite(undefined), null)
      },
      {
        name: label('null payload is refused'),
        run: async () => expectRefused(await sendWrite(null), null)
      },
      {
        name: label('text for the payload object is refused'),
        run: async () => expectRefused(await sendWrite('x'), null)
      },
      {
        name: label('a list for the payload object is refused'),
        run: async () => expectRefused(await sendWrite([withId(baseline ?? {})]), null)
      },
      {
        name: label('__proto__ / constructor / prototype keys alone are refused'),
        run: async () => expectRefused(await sendWrite(withProtoKeys(withId({}))), null)
      }
    );
    for (const column of writable) {
      const rule = rules[column]!;
      for (const bad of [
        { label: 'an object', value: { nested: 1 } },
        { label: 'a list', value: [1, 2] }
      ]) {
        genericCases.push({
          name: label(`${bad.label} for '${column}' is refused`),
          run: async () => expectRefused(await sendWrite(withId({ [column]: bad.value })), column)
        });
      }
      if (wrongScalars(rule).length === 0) {
        columnsWithoutAScalarCase.push(`${action.key}.${column}: ${rule.type}`);
      }
      for (const bad of wrongScalars(rule)) {
        genericCases.push({
          name: label(`${bad.label} for ${rule.type} '${column}' is refused`),
          run: async () => expectRefused(await sendWrite(withId({ [column]: bad.value })), column)
        });
      }
      if (TEXT_TYPES.has(rule.type) && rule.maxLength !== null) {
        const width = rule.maxLength;
        genericCases.push({
          name: label(`'${column}' one past its ${width}-character width is refused`),
          run: async () =>
            expectRefused(await sendWrite(withId({ [column]: 'a'.repeat(width + 1) })), column)
        });
      }
    }
    if (baseline) {
      genericCases.push(
        {
          name: label('unknown and privileged keys beside a valid field are stripped'),
          run: async () =>
            expectStripped(
              await sendWrite({ ...withId(baseline), ...SMUGGLED, ...withId({}) }),
              true
            )
        },
        {
          name: label('__proto__ / constructor / prototype beside a valid field are stripped'),
          run: async () => expectStripped(await sendWrite(withProtoKeys(withId(baseline))), true)
        }
      );
    } else {
      genericUncovered.push(`${action.key}: no client-writable column this can build a value for`);
    }
    if (what === 'update') {
      for (const bad of [
        { label: 'missing', value: undefined },
        { label: 'text', value: 'abc' },
        { label: 'an object', value: {} },
        { label: 'a list', value: [7] },
        { label: 'negative', value: -1 },
        { label: 'fractional', value: 1.5 }
      ]) {
        genericCases.push({
          name: label(`a ${bad.label} id is refused`),
          run: async () => expectRefused(await sendWrite({ ...baseline, id: bad.value }), null)
        });
      }
      if (baseline) {
        genericCases.push({
          name: label("another citizen's row id is never written without the caller's citizenid"),
          run: async () => {
            const outcome = await send(action, { ...baseline, id: h.HOSTILE_ID }, 'hostile');
            expectNoForeignWrite(outcome);
            expectOwnershipAsked(outcome);
          }
        });
      }
    }
  }

  if (action.action === 'delete') {
    for (const bad of [
      { label: 'missing payload', value: undefined },
      { label: 'text id', value: { id: 'abc' } },
      { label: 'object id', value: { id: {} } },
      { label: 'list id', value: { id: [7] } },
      { label: 'negative id', value: { id: -1 } },
      { label: '__proto__ / constructor / prototype keys alone', value: protoKeys() }
    ]) {
      genericCases.push({
        name: label(`a ${bad.label} is refused`),
        run: async () => expectRefused(await send(action, bad.value), null)
      });
    }
    genericCases.push({
      name: label("another citizen's row id is never written without the caller's citizenid"),
      run: async () => {
        const outcome = await send(action, { id: h.HOSTILE_ID }, 'hostile');
        expectNoForeignWrite(outcome);
        expectOwnershipAsked(outcome);
      }
    });
  }

  if (action.action === 'get') {
    const isPublic = resolved.access.read === 'public';
    const expectRead = (outcome: Outcome) => {
      expectAnsweredSafely(outcome);
      expect(outcome.writes, 'a read wrote').toEqual([]);
      expect(outcome.effects, 'a read moved something').toEqual([]);
      for (const read of outcome.reads) {
        expect(h.flat(read.params), 'a read binds a smuggled value').not.toContain(h.CID_B);
      }
      if (!isPublic) {
        expect(
          outcome.reads.some((read) => h.flat(read.params).includes(h.CID_A)),
          "positive twin: the owner read binds the caller's citizenid"
        ).toBe(true);
      }
    };
    genericCases.push(
      {
        name: label('missing payload reads only the caller’s rows'),
        run: async () => expectRead(await send(action, undefined))
      },
      {
        name: label('a list payload reads only the caller’s rows'),
        run: async () => expectRead(await send(action, [1, 2]))
      },
      {
        name: label('text payload reads only the caller’s rows'),
        run: async () => expectRead(await send(action, 'x'))
      },
      {
        name: label('smuggled owner, status and unknown filters are dropped'),
        run: async () => {
          const outcome = await send(action, { ...SMUGGLED, ...protoKeys() });
          expectRead(outcome);
          expectStripped(outcome, false);
        }
      }
    );
    for (const column of resolved.clientFilterable) {
      genericCases.push({
        name: label(`an object filter on '${column}' is refused`),
        run: async () => expectRefused(await send(action, { [column]: { nested: 1 } }), column)
      });
    }
    if (resolved.paging) {
      for (const bad of [
        { label: 'text', value: 'abc' },
        { label: 'an object', value: {} },
        { label: 'negative', value: -1 }
      ]) {
        genericCases.push({
          name: label(`a ${bad.label} cursor is refused`),
          run: async () => expectRefused(await send(action, { cursor: bad.value }), null)
        });
      }
      const ceiling = resolved.paging.maxPageSize;
      genericCases.push({
        name: label(`a limit of a billion is clamped to ${ceiling}`),
        run: async () => {
          const outcome = await send(action, { limit: 1_000_000_000 });
          expectRead(outcome);
          for (const read of outcome.reads) {
            for (const value of h.flat(read.params)) {
              if (typeof value === 'number') expect(value).toBeLessThanOrEqual(ceiling + 1);
            }
          }
        }
      });
    }
  }
}

/* ─── Custom actions: fields from the contract ───────────────────────────────────────────── */

type Path = readonly (string | number)[];

/** A path as `shared/schema.ts` names it to a player: `label`, `page.limit`, `tags[0].name`. */
const pathLabel = (path: Path): string =>
  path.reduce<string>(
    (out, segment) =>
      typeof segment === 'number'
        ? `${out}[${segment}]`
        : out === ''
          ? segment
          : `${out}.${segment}`,
    ''
  );

const getAt = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (value, segment) =>
      value && typeof value === 'object'
        ? (value as Record<string | number, unknown>)[segment]
        : undefined,
    root
  );

/** A copy of `root` with `value` at `path`, building any container the path passes through. */
const setAt = (root: unknown, path: Path, value: unknown): unknown => {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const base = root ?? (typeof head === 'number' ? [] : {});
  const copy: Record<string | number, unknown> = Array.isArray(base)
    ? ([...base] as unknown as Record<number, unknown>)
    : { ...(base as Record<string, unknown>) };
  copy[head!] = setAt(copy[head!], rest, value);
  return copy;
};

/** One declared field the sweep varies, and a valid payload that reaches it. */
interface Slot {
  path: Path;
  shape: Described;
  root: unknown;
}

/**
 * Every field of an object input, and one level inside each object or list field: a list is
 * reached through a one-item list built from its item's declaration. Deeper than that is not
 * walked, which `pathLabel` would show as a third segment nobody sends today.
 */
function collectSlots(
  objectShape: Extract<Described, { kind: 'object' }>,
  root: unknown,
  prefix: Path,
  nested: boolean,
  out: Slot[],
  pins: string[],
  key: string
): void {
  for (const [field, fieldSchema] of Object.entries(objectShape.shape)) {
    const path = [...prefix, field];
    const fieldShape = shapeOf(fieldSchema);
    if (!fieldShape) {
      pins.push(`${key}.${pathLabel(path)}: no recorded shape`);
      continue;
    }
    out.push({ path, shape: fieldShape, root });
    if (nested) continue;
    if (fieldShape.kind === 'object') {
      const built = synthesize(fieldSchema);
      const value = getAt(root, path) ?? (built.ok ? built.value : undefined);
      if (value === undefined) {
        pins.push(`${key}.${pathLabel(path)}: nothing could be built to vary inside it`);
        continue;
      }
      collectSlots(fieldShape, setAt(root, path, value), path, true, out, pins, key);
    }
    if (fieldShape.kind === 'array') {
      const itemShape = shapeOf(fieldShape.item);
      const item = synthesize(fieldShape.item);
      if (!itemShape || !item.ok || fieldShape.max === 0) {
        pins.push(`${key}.${pathLabel(path)}: no list item could be built`);
        continue;
      }
      const itemPath = [...path, 0];
      const itemRoot = setAt(root, path, [item.value]);
      out.push({ path: itemPath, shape: itemShape, root: itemRoot });
      if (itemShape.kind === 'object') {
        collectSlots(itemShape, itemRoot, itemPath, true, out, pins, key);
      }
    }
  }
}

/** A row id by its name: `id`, `postId`, `match_id`; or an item of `ids`, `postIds`, `row_ids`. */
const ID_FIELD = /(^id$|Id$|_id$)/;
const ID_LIST = /(^ids$|Ids$|_ids$)/;
const isIdSlot = (path: Path): boolean => {
  const last = path.at(-1);
  if (typeof last === 'number') {
    const list = path.at(-2);
    return typeof list === 'string' && ID_LIST.test(list);
  }
  return typeof last === 'string' && ID_FIELD.test(last);
};

/**
 * The id to steal. A number is `HOSTILE_ID`; a text id is whichever candidate the declaration
 * takes — in the hostile world any value names somebody else's row, so the point is only that it
 * is distinctive enough to find in a statement's parameters.
 */
function stolenValueFor(
  slot: Slot,
  root: Record<string, unknown>,
  acceptedRoot: (root: Record<string, unknown>) => boolean
): unknown {
  if (slot.shape.kind === 'int' || slot.shape.kind === 'number') return h.HOSTILE_ID;
  if (slot.shape.kind !== 'string') return undefined;
  return ['STOLEN-463', 'ABCDEFGHJKMNPQRS', 'STOLEN463STOLEN463STOLEN463STOLEN'].find((candidate) =>
    acceptedRoot(setAt(root, slot.path, candidate) as Record<string, unknown>)
  );
}

const CUSTOM_UNBOUNDED_LENGTH = 70_000;

/**
 * Id fields whose stolen value never reaches a statement in the mixed world, each with why. Their
 * case is named for what it does prove — refused before any statement — and the per-action
 * cross-citizen matrix that would reach them is MICA-464. Pinned both ways: a field that starts
 * reaching its statement fails until it is removed here.
 */
/**
 * Id fields reached only by a read that is public by design — a profile, a follower list, a
 * post's view — each with why. Held to that: the stolen id reaches a statement, nothing asks about
 * it as the caller's (it is not theirs, and need not be), and no write names it at all.
 */
const STOLEN_ID_NOT_ASKED: Record<string, string> = {
  'accounts:followers.account_id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'accounts:following.account_id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'accounts:follows.account_id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'blabber:profile.account_id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'blabber:view.id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'blabber:view.anchorId':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'glimpse:engagement.ids[0]':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'glimpse:profile.account_id':
    "a public read of another account's or post's rows by design; nothing it writes names the id",
  'marketplace:view.id':
    "a public read of another account's or post's rows by design; nothing it writes names the id"
};

/**
 * Id fields that name another citizen's row on purpose and are written beside the caller's
 * citizenid as the new row's owner — a report about somebody's post. Held to the write rule
 * alone: the stolen id reaches a statement, and every write naming it binds the caller's key.
 */
const STOLEN_ID_IS_TARGET: Record<string, string> = {
  'reports:create.targetId':
    "reporting somebody else's content is the feature; the report row is the reporter's (citizenid)"
};

const STOLEN_ID_NOT_REACHED: Record<string, string> = {
  'conversations:get.cursor.id':
    'a paging position, not ownership: refused as `server.payload.required.cursor` with the synthesized `time` half',
  'darkchat:removeMember.member_id':
    "another member's handle by design, matched by blind index (never bound raw); the write is scoped by the caller owning the channel",
  'music:broadcastStart.videoId':
    'not a row id: a YouTube id, refused by its own format check (`server.music.notYouTube`)',
  'music:broadcastStart.playlistId':
    'not a row id: a YouTube id, refused by its own format check (`server.music.notYouTube`)',
  'reports:reopen.id':
    'admin-only (`server.reports.notAuthorised`): the caller is no admin, and `isAdmin` is an ACE check',
  'reports:resolve.id':
    'admin-only (`server.reports.notAuthorised`): the caller is no admin, and `isAdmin` is an ACE check',
  'reports:versions.id':
    'admin-only (`server.reports.notAuthorised`): the caller is no admin, and `isAdmin` is an ACE check'
};

/**
 * The payload a stolen-id case sends, around the attacked field:
 *
 * - every other top-level id set to the caller's own (`OWNED_ID`) — the account a post is made
 *   as, the conversation a message is in — so the mixed world answers those as the caller's and
 *   the handler reaches the id under attack;
 * - a field that must name a runtime registry's member set to a real one, read from the registry
 *   itself, never written here: an `app` with a DM policy, a reactable or reportable table. A
 *   synthesized `'a'` is refused by the registry before the stolen id is ever read.
 *
 * Each change is kept only where the contract still accepts the payload.
 */
function worldRootFor(
  action: Action,
  root: Record<string, unknown>,
  attacked: Path,
  acceptedRoot: (root: Record<string, unknown>) => boolean
): Record<string, unknown> {
  let out = root;
  const tryValue = (key: string, value: unknown) => {
    const next = { ...out, [key]: value };
    if (acceptedRoot(next)) out = next;
  };
  for (const [key, value] of Object.entries(root)) {
    if (key === attacked[0]) continue;
    if (ID_FIELD.test(key) && typeof value === 'number') tryValue(key, h.OWNED_ID);
    const registered = registryValueFor(action, key);
    if (registered !== undefined) tryValue(key, registered);
  }
  return out;
}

/**
 * The registries a payload field names a member of, by the field's name. The members come from
 * the registries as the loaded server holds them; only which registry a name means is written
 * here, and the vacuity block below pins that each registry answers with a member.
 */
function registryValueFor(action: Action, key: string): string | undefined {
  if (key === 'app') {
    return [...new Set(serviceApps().values())].find((app) => dmPolicyForTests(app) !== undefined);
  }
  if (key === 'number' && action.service === 'jobs') return jobLineNumbers()[0];
  if (key === 'target_table' || key === 'targetTable') {
    return action.service === 'reports'
      ? Object.keys(REPORTABLE())[0]
      : [...reactableTables().keys()][0];
  }
  return undefined;
}

const customCases: Case[] = [];
/** `<service>:<action>` → why per-field cases could not be built for it. */
const customUncovered: string[] = [];
/** Fields inside a described object that have no wrong type to send. */
const fieldsUncovered: string[] = [];

/** One sentinel per action for the strip check: a key no contract declares. */
const STRIP_EXTRAS = {
  evil_column_463: 'smuggled-463',
  citizenid: h.CID_B,
  status: 'smuggled-status-463'
};

for (const action of customActions) {
  const input = contractFor(action.service)?.actions[action.action]?.input;
  const shape = shapeOf(input);
  const label = (what: string) => `${action.key} — ${what}`;

  if (!shape) {
    customUncovered.push(`${action.key}: input has no recorded shape`);
    customCases.push({
      name: label('a hostile payload is answered safely'),
      run: async () => {
        for (const payload of [undefined, 'x', [1], protoKeys()])
          expectAnsweredSafely(await send(action, payload));
      }
    });
    continue;
  }

  const takesNothing = shape.kind === 'none';
  const isObject = shape.kind === 'object' && !shape.optional;

  if (isObject || takesNothing) {
    customCases.push(
      {
        name: label('text for the payload is refused'),
        run: async () => expectRefused(await send(action, 'x'), 'That value')
      },
      {
        name: label('a number for the payload is refused'),
        run: async () => expectRefused(await send(action, 42), 'That value')
      },
      {
        name: label('a list for the payload is refused'),
        run: async () => expectRefused(await send(action, [{}]), 'That value')
      }
    );
  }
  if (isObject) {
    customCases.push(
      {
        name: label('missing payload is refused'),
        run: async () => expectRefused(await send(action, undefined), 'That value')
      },
      {
        name: label('null payload is refused'),
        run: async () => expectRefused(await send(action, null), 'That value')
      }
    );
  }
  if (takesNothing) {
    customCases.push({
      name: label('__proto__ / constructor / prototype keys are refused'),
      run: async () => expectRefused(await send(action, protoKeys()), 'That value')
    });
    continue;
  }
  if (!isObject) {
    customUncovered.push(
      `${action.key}: input is ${shape.optional ? 'an optional ' : ''}${shape.kind}`
    );
    customCases.push({
      name: label('a hostile payload is answered safely'),
      run: async () => {
        for (const payload of ['x', [1], protoKeys()])
          expectAnsweredSafely(await send(action, payload));
      }
    });
    continue;
  }

  // Narrowed for the compiler: `isObject` above already said so.
  if (shape.kind !== 'object') continue;
  const declared = new Set(Object.keys(shape.shape));
  const built = synthesize(input);

  if (!built.ok) {
    customUncovered.push(`${action.key}: no valid payload could be built (${built.why})`);
    if (!shape.strip) {
      customCases.push({
        name: label('__proto__ / constructor / prototype keys alone are refused'),
        run: async () => expectRefused(await send(action, protoKeys()), '__proto__')
      });
    }
    continue;
  }
  const baseline = built.value as Record<string, unknown>;
  const baselineAccepted = input!['~standard'].validate(baseline);
  if (baselineAccepted instanceof Promise || baselineAccepted.issues) {
    customUncovered.push(`${action.key}: the built payload is refused by its own schema`);
    continue;
  }

  if (shape.strip) {
    customCases.push(
      {
        name: label('unknown keys beside a valid payload are stripped'),
        run: async () => expectStripped(await send(action, { ...baseline, ...STRIP_EXTRAS }), false)
      },
      {
        name: label('__proto__ / constructor / prototype beside a valid payload are stripped'),
        run: async () => expectStripped(await send(action, withProtoKeys(baseline)), false)
      }
    );
  } else {
    const smuggled = Object.fromEntries(
      Object.entries(SMUGGLED).filter(([key]) => !declared.has(key))
    );
    const firstUndeclared = Object.keys(smuggled)[0]!;
    customCases.push(
      {
        name: label('__proto__ / constructor / prototype keys alone are refused'),
        run: async () => expectRefused(await send(action, protoKeys()), '__proto__')
      },
      {
        name: label('__proto__ / constructor / prototype beside a valid payload are refused'),
        run: async () => expectRefused(await send(action, withProtoKeys(baseline)), '__proto__')
      },
      {
        name: label('unknown and privileged keys beside a valid payload are refused'),
        run: async () =>
          expectRefused(await send(action, { ...baseline, ...smuggled }), firstUndeclared)
      }
    );
  }

  const slots: Slot[] = [];
  collectSlots(shape, baseline, [], false, slots, fieldsUncovered, action.key);
  const accepted = new WeakMap<object, boolean>();
  const acceptedRoot = (root: Record<string, unknown>): boolean => {
    if (!accepted.has(root)) {
      const outcome = input!['~standard'].validate(root);
      accepted.set(root, !(outcome instanceof Promise) && !outcome.issues);
    }
    return accepted.get(root)!;
  };

  for (const slot of slots) {
    const root = slot.root as Record<string, unknown>;
    const at = pathLabel(slot.path);
    if (!acceptedRoot(root)) {
      fieldsUncovered.push(`${action.key}.${at}: the payload built to reach it is refused`);
      continue;
    }
    const sendAt = (value: unknown, mode?: 'hostile' | 'mixed') =>
      send(action, setAt(root, slot.path, value), mode);
    const wrong = wrongTypes(slot.shape);
    if (wrong.length === 0) fieldsUncovered.push(`${action.key}.${at}: ${slot.shape.kind}`);
    for (const bad of wrong) {
      customCases.push({
        name: label(`${bad.label} for ${slot.shape.kind} '${at}' is refused`),
        run: async () => expectRefused(await sendAt(bad.value), at)
      });
    }
    if (slot.shape.kind === 'string' && slot.shape.truncate === undefined) {
      const max = slot.shape.max;
      // A declared bound is held at one past it. A string with none must still refuse a length
      // no column holds — so a contract that loses its `max` fails here, by name.
      const over = max === undefined ? CUSTOM_UNBOUNDED_LENGTH : max + 1;
      customCases.push({
        name: label(
          max === undefined
            ? `'${at}', declared with no bound, refuses ${over} characters`
            : `'${at}' one past its ${max}-character bound is refused`
        ),
        run: async () => expectRefused(await sendAt('a'.repeat(over)), at)
      });
    }
    const stolen = isIdSlot(slot.path) ? stolenValueFor(slot, root, acceptedRoot) : undefined;
    if (isIdSlot(slot.path) && stolen === undefined) {
      fieldsUncovered.push(`${action.key}.${at}: an id no stolen value fits`);
    }
    if (stolen !== undefined) {
      // Every other id in the payload is the caller's own, so a handler that resolves their
      // account or row first finds it and goes on to meet the stolen one.
      const ownRoot = worldRootFor(action, root, slot.path, acceptedRoot);
      const pin = `${action.key}.${at}`;
      const notReached = pin in STOLEN_ID_NOT_REACHED;
      const notAsked = pin in STOLEN_ID_NOT_ASKED;
      const isTarget = pin in STOLEN_ID_IS_TARGET;
      customCases.push({
        name: label(
          notReached
            ? `another citizen's '${at}' is refused before any statement names it`
            : notAsked
              ? `another citizen's '${at}' is only read, and nothing written names it`
              : isTarget
                ? `another citizen's '${at}' is written only beside the caller's citizenid`
                : `another citizen's '${at}' is checked as the caller's, and never written otherwise`
        ),
        run: async () => {
          const outcome = await send(action, setAt(ownRoot, slot.path, stolen), 'mixed');
          expectNoForeignWrite(outcome, stolen);
          expectRanToItsOwnAnswer(outcome);
          const named = [...outcome.reads, ...outcome.writes].some((s) =>
            statementNames(s, stolen)
          );
          const asked = ownershipAsked(outcome, stolen);
          const refused = refusedAfterReaching(outcome, stolen);
          const answered = JSON.stringify(outcome.replies);
          /**
           * The twin, by category. Default: the stolen id reached a statement, and then either the
           * ownership question was asked about it with the caller's key (`ownershipAsked`), or the
           * handler refused (`refusedAfterReaching`). A handler that dropped its check and wrote
           * with whatever the payload named does neither, and fails here even where its INSERT
           * stamped the caller's citizenid. Pinned, each with why, and both ways: refused before
           * any statement names the id (`STOLEN_ID_NOT_REACHED`), or reached only by a read that
           * is public by design, with no write naming it at all (`STOLEN_ID_NOT_ASKED`).
           */
          if (notReached) {
            expect(
              named,
              `'${pin}' now reaches a statement; unpin it from STOLEN_ID_NOT_REACHED`
            ).toBe(false);
          } else if (notAsked) {
            expect(
              named,
              `'${pin}' no longer reaches a statement; move its pin. Answered: ${answered}`
            ).toBe(true);
            expect(
              asked || refused,
              `'${pin}' is now asked about or refused; unpin it from STOLEN_ID_NOT_ASKED`
            ).toBe(false);
            expect(
              outcome.writes.filter((write) => statementNames(write, stolen)),
              `'${pin}' is pinned as only read, but a write names it`
            ).toEqual([]);
          } else if (isTarget) {
            expect(
              named,
              `'${pin}' no longer reaches a statement; move its pin. Answered: ${answered}`
            ).toBe(true);
          } else {
            expect(
              named && (asked || refused),
              named
                ? `the stolen '${at}' reached a statement, but nothing asked about it beside the caller's key and the handler did not refuse. Answered: ${answered}`
                : `the stolen '${at}' never reached a statement, so this proves nothing. Answered: ${answered}`
            ).toBe(true);
          }
        }
      });
    }
  }
}

/* ─── Raw onNet handlers ─────────────────────────────────────────────────────────────────── */

/**
 * Argument lists no raw handler's tuple admits, sent to every one whatever it declares. Each handler
 * is guarded by `guardNetEvent`, which refuses silently: there is no reply to read, so a refusal is
 * the guard answering no and nothing else happening.
 */
const RAW_HOSTILE: { label: string; args: () => unknown[] }[] = [
  { label: 'a 70,000-character string', args: () => ['a'.repeat(CUSTOM_UNBOUNDED_LENGTH)] },
  { label: '__proto__ / constructor / prototype keys', args: () => [protoKeys()] },
  { label: 'a nested list', args: () => [[[1]]] },
  {
    label: 'an extra argument carrying a value',
    args: () => [undefined, undefined, undefined, 'extra']
  },
  { label: 'NaN', args: () => [Number.NaN] }
];

async function fireRaw(event: string, args: unknown[]): Promise<Outcome> {
  h.world.mode = 'empty';
  (globalThis as any).source = h.CALLER_SRC;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => {
      for (const handler of h.handlers.get(event) ?? []) await handler(...args);
    })(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${event} did not finish within ${ANSWER_WITHIN_MS} ms`)),
        ANSWER_WITHIN_MS
      );
    })
  ]).finally(() => clearTimeout(timer));
  await settle();
  return {
    replies: [],
    writes: [...h.writes],
    reads: [...h.reads],
    effects: [...h.effects],
    pushes: [...pushes],
    logged: [...logged]
  };
}

/** Refused at the guard, and nothing happened. */
function expectRawRefused(outcome: Outcome): void {
  expect(
    h.guard.passed.length,
    'the guard was never asked, so this proves nothing'
  ).toBeGreaterThan(0);
  expect(h.guard.passed, 'the guard let it through').toEqual(h.guard.passed.map(() => false));
  expect(outcome.writes, 'wrote').toEqual([]);
  expect(outcome.effects, 'moved something').toEqual([]);
  expect(outcome.pushes, 'pushed').toEqual([]);
  expect(outcome.logged, 'logged an error').toEqual([]);
  expect(Object.keys(Object.prototype), 'Object.prototype polluted').toEqual([]);
}

/** Each raw event's declared tuple, found by firing it once with the guard answering no. */
const rawTuples = new Map<string, StandardSchemaV1>();
const rawUncovered: string[] = [];
h.guard.discovering = true;
for (const event of rawEvents) {
  h.guard.calls.length = 0;
  (globalThis as any).source = h.CALLER_SRC;
  for (const handler of h.handlers.get(event) ?? []) void handler();
  const schemas = [...new Set(h.guard.calls.map((call) => call.schema))];
  if (schemas.length === 1) rawTuples.set(event, schemas[0] as StandardSchemaV1);
  else rawUncovered.push(`${event}: guardNetEvent saw ${schemas.length} schemas before any await`);
}
h.guard.discovering = false;
h.guard.calls.length = 0;

const rawCases: Case[] = [];
for (const event of rawEvents) {
  const label = (what: string) => `${event} — ${what}`;
  for (const bad of RAW_HOSTILE) {
    rawCases.push({
      name: label(bad.label),
      run: async () => expectRawRefused(await fireRaw(event, bad.args()))
    });
  }
  const tuple = rawTuples.get(event);
  if (!tuple) continue;
  const shape = shapeOf(tuple);
  if (!shape || shape.kind !== 'tuple') {
    rawUncovered.push(`${event}: its guard schema is ${shape?.kind ?? 'undescribed'}`);
    continue;
  }
  const built = synthesize(tuple);
  if (!built.ok) {
    rawUncovered.push(`${event}: no valid arguments could be built (${built.why})`);
    continue;
  }
  const baseline = built.value as unknown[];
  rawCases.push({
    name: label('positive twin: valid arguments pass the guard'),
    run: async () => {
      await fireRaw(event, baseline);
      expect(h.guard.passed).toContain(true);
    }
  });
  rawCases.push({
    name: label('an extra argument beside valid ones is refused'),
    run: async () => expectRawRefused(await fireRaw(event, [...baseline, 'extra']))
  });
  if (shape.elements.some((element) => !shapeOf(element)?.optional)) {
    rawCases.push({
      name: label('no arguments are refused'),
      run: async () => expectRawRefused(await fireRaw(event, []))
    });
  }
  shape.elements.forEach((element, index) => {
    const elementShape = shapeOf(element);
    const at = `[${index}]`;
    if (!elementShape) {
      rawUncovered.push(`${event}${at}: no recorded shape`);
      return;
    }
    const argsWith = (value: unknown) => baseline.map((arg, i) => (i === index ? value : arg));
    const wrong = wrongTypes(elementShape);
    if (wrong.length === 0) rawUncovered.push(`${event}${at}: ${elementShape.kind}`);
    if (elementShape.kind === 'object') {
      // The fields of an object argument, varied as a custom action's are.
      const slots: Slot[] = [];
      collectSlots(elementShape, baseline[index], [], false, slots, rawUncovered, `${event}${at}`);
      for (const slot of slots) {
        const inner = pathLabel(slot.path);
        const argsAt = (value: unknown) => argsWith(setAt(slot.root, slot.path, value));
        const twin = tuple['~standard'].validate(argsWith(slot.root));
        if (twin instanceof Promise || twin.issues) {
          rawUncovered.push(`${event}${at}.${inner}: the arguments built to reach it are refused`);
          continue;
        }
        const innerWrong = wrongTypes(slot.shape);
        if (innerWrong.length === 0)
          rawUncovered.push(`${event}${at}.${inner}: ${slot.shape.kind}`);
        for (const bad of innerWrong) {
          rawCases.push({
            name: label(`${bad.label} for ${slot.shape.kind} '${at}.${inner}' is refused`),
            run: async () => expectRawRefused(await fireRaw(event, argsAt(bad.value)))
          });
        }
        if (slot.shape.kind === 'string' && slot.shape.truncate === undefined) {
          const max = slot.shape.max;
          const over = max === undefined ? CUSTOM_UNBOUNDED_LENGTH : max + 1;
          rawCases.push({
            name: label(`'${at}.${inner}' at ${over} characters is refused`),
            run: async () => expectRawRefused(await fireRaw(event, argsAt('a'.repeat(over))))
          });
        }
      }
    }
    for (const bad of wrong) {
      rawCases.push({
        name: label(`${bad.label} for ${elementShape.kind} argument ${at} is refused`),
        run: async () => expectRawRefused(await fireRaw(event, argsWith(bad.value)))
      });
    }
    if (elementShape.kind === 'string' && elementShape.truncate === undefined) {
      const max = elementShape.max;
      const over = max === undefined ? CUSTOM_UNBOUNDED_LENGTH : max + 1;
      rawCases.push({
        name: label(
          max === undefined
            ? `argument ${at}, declared with no bound, refuses ${over} characters`
            : `argument ${at} one past its ${max}-character bound is refused`
        ),
        run: async () => expectRawRefused(await fireRaw(event, argsWith('a'.repeat(over))))
      });
    }
  });
}

/**
 * Events a raw handler answers that micaOS did not name, each with why it takes none of the sweep.
 * Pinned, so another one registered fails until somebody decides.
 */
const FOREIGN_EVENTS: Record<string, string> = {
  'QBCore:Server:OnPlayerLoaded':
    "qb-core's own loaded event; shell.ts reads only the source, through loadedPlayerSource",
  'pma-voice:setPlayerCall':
    "pma-voice's join; micaOS reads no argument and must not rate-limit it (MICA-341)",
  'qb-phone:server:sendNewMail':
    'qb-phone compatibility (MICA-222): mails the source by design, so a write is the point'
};

/** A pinned field as the sweep names it while walking: `settings:set.value: unknown`. */
const fieldKey = ({ event, field, kind }: NotVariedField): string =>
  `${event.slice(PREFIX.length)}.${field}: ${kind}`;
/** A pinned raw argument as the sweep names it: `mica:server:shell:setOpen[0]: union`. */
const argumentKey = ({ event, arg, kind }: NotVariedArgument): string =>
  `${event}[${arg}]: ${kind}`;

/* ─── The suite ──────────────────────────────────────────────────────────────────────────── */

describe('the sweep is not vacuous', () => {
  it('found the whole registered surface, exactly', () => {
    // Exact, not a floor: a module that starts registering, or one that stops, changes these
    // and has to be looked at. `server.ts` is imported whole, so nothing is left out by hand.
    expect({
      endpoint: endpointActions.length,
      generic: genericActions.length,
      custom: customActions.length,
      raw: rawEvents.length,
      foreign: foreignEvents.length
    }).toEqual({ endpoint: 175, generic: 21, custom: 154, raw: 9, foreign: 3 });
    expect(genericCases.length).toBeGreaterThan(200);
    expect(customCases.length).toBeGreaterThan(500);
  });

  it('records contract shapes, so per-field cases exist', () => {
    const described = customActions.filter((a) =>
      shapeOf(contractFor(a.service)?.actions[a.action]?.input)
    );
    expect(described.length).toBe(customActions.length);
  });

  it('reads a member from every registry a stolen-id payload needs', () => {
    const at = (service: string): Action => ({ service, action: 'x', key: `${service}:x` });
    expect(registryValueFor(at('dms'), 'app')).toEqual(expect.any(String));
    expect(registryValueFor(at('accounts'), 'target_table')).toEqual(expect.any(String));
    expect(registryValueFor(at('reports'), 'targetTable')).toEqual(expect.any(String));
    expect(registryValueFor(at('jobs'), 'number')).toBe('555-0911');
  });

  it('holds the hoisted device id to the phone stub', () => {
    expect(h.CALLER_DEVICE).toBe(TEST_PHONE_ID);
  });

  describe('the cross-citizen oracle', () => {
    const outcomeOf = (sql: string, params: unknown[]): Outcome => ({
      replies: [],
      writes: [{ via: 'update', sql, params }],
      reads: [],
      effects: [],
      pushes: [],
      logged: []
    });

    it('refuses a takeover that binds the caller only in its SET', () => {
      const takeover = outcomeOf('UPDATE `t` SET `citizenid` = ? WHERE `id` = ?', [
        h.CID_A,
        h.HOSTILE_ID
      ]);
      expect(() => expectNoForeignWrite(takeover)).toThrow(/no caller key in its WHERE/);
    });

    it('sees a stolen id written into the SQL as a literal', () => {
      const literal = outcomeOf(`UPDATE \`t\` SET \`body\` = ? WHERE \`id\` = ${h.HOSTILE_ID}`, [
        'x'
      ]);
      expect(() => expectNoForeignWrite(literal)).toThrow(/no caller key in its WHERE/);
    });

    it('sees a write behind a leading comment', () => {
      expect(h.verbOf('/* audit */ -- why\n  UPDATE `t` SET `a` = ?')).toBe('UPDATE');
    });

    const ownedAccountRead = {
      via: 'single',
      sql: 'SELECT * FROM `mica_accounts` WHERE `id` = ? AND `citizenid` = ?',
      params: [h.OWNED_ID, h.CID_A]
    };

    it("accepts a write scoped by the caller's own account, once a read earned it", () => {
      const byAccount = outcomeOf(
        "UPDATE `t` SET `status` = 'deleted' WHERE `id` = ? AND `account_id` = ?",
        [h.HOSTILE_ID, h.OWNED_ID]
      );
      expect(() => expectNoForeignWrite({ ...byAccount, reads: [ownedAccountRead] })).not.toThrow();
    });

    it("refuses the caller's account id when only the payload named it", () => {
      // The follow handler with its `ownedAccount` check deleted: the follower is whatever the
      // payload said, and nothing asked whether it is the caller's.
      const planted = {
        ...outcomeOf(
          'INSERT INTO `mica_account_follows` (`follower_account_id`, `followee_account_id`) VALUES (?, ?)',
          [h.HOSTILE_ID, h.OWNED_ID]
        ),
        reads: [
          {
            via: 'single',
            sql: 'SELECT * FROM `mica_accounts` WHERE `id` = ?',
            params: [h.OWNED_ID]
          }
        ]
      };
      expect(() => expectNoForeignWrite(planted)).toThrow(/without the caller's key/);
    });

    it('does not take a citizenid stamped beside a stolen account as asking about it', () => {
      const stamped = outcomeOf(
        'INSERT INTO `t` (`citizenid`, `account_id`, `body`) VALUES (?, ?, ?)',
        [h.CID_A, h.HOSTILE_ID, 'x']
      );
      expect(ownershipAsked(stamped, h.HOSTILE_ID)).toBe(false);
      expect(ownershipAsked({ ...stamped, reads: [ownedAccountRead] }, h.HOSTILE_ID)).toBe(false);
    });

    it('accepts a write whose WHERE binds the caller beside the id', () => {
      const scoped = outcomeOf('UPDATE `t` SET `body` = ? WHERE `id` = ? AND `citizenid` = ?', [
        'x',
        h.HOSTILE_ID,
        h.CID_A
      ]);
      expect(() => expectNoForeignWrite(scoped)).not.toThrow();
    });
  });

  it('positive twin: a refusal check sees a write, a push and a generic answer', () => {
    const outcome: Outcome = {
      replies: [{ error: 'x', key: GENERIC_ERROR_KEY }],
      writes: [{ via: 'insert', sql: 'INSERT INTO t', params: [] }],
      reads: [],
      effects: [],
      pushes: [],
      logged: []
    };
    expect(() => expectRefused(outcome, null)).toThrow();
    expect(() => expectRefused({ ...outcome, replies: [] }, null)).toThrow();
  });
});

describe('every generic CRUD action, from its declaration', () => {
  it.each(genericCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => c.run());
});

describe('every custom action, from its contract', () => {
  it.each(customCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => c.run());
});

describe('every raw mica handler, from its guard', () => {
  it.each(rawCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => c.run());

  it('positive twin: battery:load with no argument pushes the charge', async () => {
    const outcome = await fireRaw('mica:server:battery:load', []);
    expect(outcome.pushes.length).toBeGreaterThan(0);
  });
});

describe('what the sweep cannot describe is a pinned decision, not a skip', () => {
  it('names every event micaOS answers but did not name', () => {
    expect(foreignEvents).toEqual(Object.keys(FOREIGN_EVENTS).toSorted());
  });

  it('names every generic action it cannot build a value for', () => {
    expect(genericUncovered).toEqual([]);
  });

  it('names every custom action it cannot sweep field by field', () => {
    expect(customUncovered).toEqual([]);
  });

  it('names every client-writable column with no wrong scalar to send', () => {
    expect(columnsWithoutAScalarCase).toEqual([]);
  });

  it('names every raw handler argument it cannot vary', () => {
    expect(rawUncovered).toEqual(RAW_ARGUMENTS_NOT_VARIED.map(argumentKey));
  });

  it('names every declared field with no wrong type to send', () => {
    expect(fieldsUncovered).toEqual(FIELDS_WITHOUT_A_WRONG_TYPE.map(fieldKey));
  });
});
