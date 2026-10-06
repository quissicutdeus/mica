// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * A job line's shared inbox (MICA-307): who may open it, what each action refuses, and what the
 * three reads and the reply hand back. The registry and `mica_job_lines` sync are the real
 * ones, configured through the convar; the database is a stub routed by statement, and sealed
 * bodies are sealed for real with a throwaway key, as `encryptedColumns.test.ts` does it.
 *
 * What this cannot show is the SQL itself running: the order, the cap and the per-thread newest
 * message are the statement's, and only the statement's text is held here.
 */

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const pushes = vi.hoisted(() => ({ pushMany: vi.fn(), push: vi.fn() }));
vi.mock('../lib/appEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/appEvents')>()),
  appEventChannel: (appId: string) => ({
    appId,
    push: pushes.push,
    pushMany: (...args: unknown[]) => {
      pushes.pushMany(appId, ...args);
      return { delivered: [], offline: [] };
    }
  })
}));

const sent = vi.hoisted(() => ({
  sendFromLine: vi.fn(async () => ({ conversationId: 9101, messageId: 555, delivered: true }))
}));
vi.mock('../services/Messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/Messages')>()),
  sendFromLine: sent.sendFromLine
}));

import '../services/Jobs';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { __resetRateLimits } from '../lib/rateLimit';
import { registerNumber, releaseResource, lookupLine, tellLine } from '../lib/numberRegistry';
import { __resetJobLines, refreshJobLines } from '../lib/jobLines';
import {
  contentContext,
  encryptedColumn,
  isSealed,
  resetContentCipherForTests,
  sealContent
} from '../lib/contentCipher';
import { JOB_LINE_INBOX_MAX } from '@mica/shared/contracts/jobs';

// ─── fixtures ────────────────────────────────────────────────────────────────

const keyDir = mkdtempSync(join(tmpdir(), 'mica-jobline-'));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));
const keyPath = join(keyDir, 'content.key');
writeFileSync(keyPath, `k1 ${randomBytes(32).toString('base64')}\n`);
chmodSync(keyPath, 0o600);

const JOB_LINES = JSON.stringify([
  { number: '911', label: 'Emergency', jobs: ['police', 'sheriff'], blockable: false },
  { number: '555-0100', label: 'Bennys', jobs: ['mechanic'], requireDuty: false }
]);

interface Job {
  name: string;
  active: boolean;
  onDuty: boolean | null;
}
const job = (name: string, over: Partial<Job> = {}) => ({
  name,
  label: name,
  grade: 0,
  gradeLabel: '0',
  salary: 0,
  isBoss: false,
  active: true,
  onDuty: true,
  ...over
});

/** Connected players by source. 1 is the default caller. */
const players = new Map<number, { citizenid: string; jobs: ReturnType<typeof job>[] }>();

/** The pair columns of each thread `lineKeyOf` is asked about. */
const threads: Record<number, { participant_a: string; participant_b: string }> = {
  9101: { participant_a: 'aaaa', participant_b: 'ext:911' },
  9102: { participant_a: 'bbbb', participant_b: 'ext:911' },
  9201: { participant_a: 'cccc', participant_b: 'ext:555-0100' },
  9301: { participant_a: 'aaaa', participant_b: 'dddd' }
};

let inboxRows: Record<string, unknown>[] = [];
let pageRows: Record<string, unknown>[] = [];
/** The newest live row before a text, as `newestLiveBefore` reads it; null for none. */
let previousRow: { external_sender: string | null } | null | Error = null;
const statements: { sql: string; params: unknown[] }[] = [];

const ofStatement = (fragment: string) => statements.filter(({ sql }) => sql.includes(fragment));

const EVENT = (action: string) => `mica:server:jobs:${action}`;

/** Run an action as `src`; the reply is the last client emit, or `{ error }` for a refusal. */
const call = async (action: string, data: unknown, src = 1) => {
  (globalThis as any).source = src;
  (globalThis as any).emitNet = vi.fn();
  const handler = handlers.get(EVENT(action));
  if (!handler) throw new Error(`no handler for ${action}`);
  await handler('cb-1', data);
  const replies = (globalThis.emitNet as any).mock.calls.filter((c: unknown[]) =>
    String(c[0]).startsWith('mica:client:')
  );
  return replies.at(-1)?.[3];
};

const sealedFor = async (citizenid: string, conversationId: number, text: string) => {
  const entry = encryptedColumn('mica_messages', 'message')!;
  const sealed = await sealContent(
    contentContext(entry, { citizenid, conversation_id: conversationId }),
    text
  );
  expect(isSealed(sealed)).toBe(true);
  return sealed;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  resetContentCipherForTests();
  releaseResource('mica');
  releaseResource('cd_dispatch');
  __resetJobLines();
  statements.length = 0;
  inboxRows = [];
  pageRows = [];
  previousRow = null;

  players.clear();
  players.set(1, { citizenid: 'CID_COP', jobs: [job('police')] });
  players.set(2, { citizenid: 'CID_OFFDUTY', jobs: [job('police', { onDuty: false })] });
  players.set(3, { citizenid: 'CID_CIV', jobs: [job('taxi')] });
  players.set(4, { citizenid: 'CID_COP2', jobs: [job('sheriff')] });
  players.set(5, { citizenid: 'CID_MECH', jobs: [job('mechanic', { onDuty: false })] });
  players.set(6, {
    citizenid: 'CID_BENCHED',
    jobs: [job('taxi'), job('police', { active: false })]
  });

  (globalThis as any).GetConvar = (name: string, fallback: string) => {
    if (name === 'mica_content_key_file') return keyPath;
    if (name === 'mica_job_lines') return JOB_LINES;
    return fallback;
  };

  vi.spyOn(FrameworkBridge, 'getPlayer').mockImplementation((src: number) => {
    const p = players.get(src);
    if (!p) return null;
    return {
      citizenid: p.citizenid,
      source: src,
      phone: null,
      getJobs: () => p.jobs.map((j) => ({ ...j })),
      setActiveJob: () => false,
      setDuty: () => false
    } as any;
  });
  vi.spyOn(FrameworkBridge, 'getAllPlayers').mockImplementation(() =>
    Object.fromEntries([...players].map(([src, p]) => [src, { PlayerData: p }]))
  );
  vi.spyOn(FrameworkBridge, 'getPlayerByPhone').mockReturnValue(null);

  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    statements.push({ sql: text, params });
    if (text.includes('information_schema.TABLES')) return [{ n: 1 }];
    if (text.includes('information_schema.COLUMNS')) return [{ chars: 65535, bytes: 65535 }];
    if (text.includes('`mica_schema_migrations`'))
      return text.startsWith('SELECT') ? [{ n: 0 }] : {};
    if (text.includes('SELECT c.participant_a, c.participant_b')) {
      const thread = threads[params[0] as number];
      return thread ? [thread] : [];
    }
    if (text.includes('c.participant_b = ?')) return inboxRows;
    if (text.includes('a.message_id = m.id')) return pageRows;
    return [];
  });
  dbMock.single.mockImplementation(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql: String(sql), params });
    if (String(sql).includes('FROM mica_messages_participants p')) {
      return { citizenid: 'CID_PLAYER' };
    }
    if (String(sql).includes('SELECT m.external_sender FROM mica_messages m')) {
      if (previousRow instanceof Error) throw previousRow;
      return previousRow;
    }
    return null;
  });
  dbMock.scalar.mockResolvedValue(null);

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  refreshJobLines();
  // A script's own line, filed under police: it lists in the Jobs app, and is never an inbox.
  registerNumber('5559999', { onCall: () => ({ action: 'reject' }), job: 'police' }, 'cd_dispatch');
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
});

const REFUSAL = {
  error: 'That line is not available to you.',
  key: 'server.jobs.lineUnavailable'
};

/** The refusal as the client receives it: the same message and key, however it arose. */
const refusalOf = (reply: any) => ({ error: reply?.error, key: reply?.errorKey ?? reply?.key });

// ─── the flag ────────────────────────────────────────────────────────────────

describe('JobLine.inbox (MICA-307)', () => {
  const linesOf = (reply: any[], jobName: string) =>
    reply.find((held) => held.name === jobName)?.lines ?? [];

  it('is true on a config line for a player who is its staff right now', async () => {
    const reply = await call('getJobs', undefined, 1);
    expect(linesOf(reply, 'police')).toEqual([
      { number: '911', label: 'Emergency', inbox: true },
      { number: '5559999', label: '5559999', inbox: false }
    ]);
  });

  it('is false on a script line, even for staff of the same job', async () => {
    const reply = await call('getJobs', undefined, 1);
    expect(linesOf(reply, 'police').find((l: any) => l.number === '5559999').inbox).toBe(false);
  });

  it('is false for a member off duty on a line that requires duty', async () => {
    const reply = await call('getJobs', undefined, 2);
    expect(linesOf(reply, 'police').find((l: any) => l.number === '911').inbox).toBe(false);
  });

  it('is true off duty on a line that does not require it', async () => {
    const reply = await call('getJobs', undefined, 5);
    expect(linesOf(reply, 'mechanic')).toEqual([
      { number: '555-0100', label: 'Bennys', inbox: true }
    ]);
  });

  it('is false under a held job that is not the active one', async () => {
    const reply = await call('getJobs', undefined, 6);
    expect(linesOf(reply, 'police').find((l: any) => l.number === '911').inbox).toBe(false);
  });

  it('agrees for a second job that staffs the same line', async () => {
    const reply = await call('getJobs', undefined, 4);
    expect(linesOf(reply, 'sheriff')).toEqual([{ number: '911', label: 'Emergency', inbox: true }]);
  });
});

// ─── refusals ────────────────────────────────────────────────────────────────

describe('every inbox action refuses with one indistinguishable error (MICA-307)', () => {
  const payloads = {
    lineInbox: (number: string) => ({ number }),
    lineThread: (number: string, conversation_id = 9101) => ({ number, conversation_id }),
    lineReply: (number: string, conversation_id = 9101) => ({
      number,
      conversation_id,
      message: 'On our way'
    })
  } as const;
  const actions = Object.keys(payloads) as (keyof typeof payloads)[];

  it.each(actions)('%s: a number that is no line', async (action) => {
    expect(refusalOf(await call(action, payloads[action]('555-1234')))).toEqual(REFUSAL);
  });

  it.each(actions)('%s: a script line, whoever asks', async (action) => {
    expect(refusalOf(await call(action, payloads[action]('5559999')))).toEqual(REFUSAL);
  });

  it.each(actions)('%s: a player who is not the line staff', async (action) => {
    expect(refusalOf(await call(action, payloads[action]('911'), 3))).toEqual(REFUSAL);
  });

  it.each(actions)('%s: staff who are off duty', async (action) => {
    expect(refusalOf(await call(action, payloads[action]('911'), 2))).toEqual(REFUSAL);
  });

  it.each(['lineThread', 'lineReply'] as const)(
    "%s: another line's thread, read by this line's staff",
    async (action) => {
      expect(refusalOf(await call(action, payloads[action]('911', 9201)))).toEqual(REFUSAL);
    }
  );

  it.each(['lineThread', 'lineReply'] as const)(
    '%s: a thread between two phones, and one that does not exist',
    async (action) => {
      expect(refusalOf(await call(action, payloads[action]('911', 9301)))).toEqual(REFUSAL);
      expect(refusalOf(await call(action, payloads[action]('911', 424242)))).toEqual(REFUSAL);
    }
  );

  it('reads no row and sends nothing for any refusal', async () => {
    await call('lineThread', payloads.lineThread('911', 9201));
    await call('lineReply', payloads.lineReply('911', 9201));
    await call('lineInbox', payloads.lineInbox('911'), 3);
    expect(ofStatement('a.message_id = m.id')).toEqual([]);
    expect(ofStatement('c.participant_b = ?')).toEqual([]);
    expect(sent.sendFromLine).not.toHaveBeenCalled();
    expect(pushes.pushMany).not.toHaveBeenCalled();
  });
});

// ─── lineInbox ───────────────────────────────────────────────────────────────

describe('lineInbox (MICA-307)', () => {
  it("asks for this line's threads, newest activity first, capped, and opens sealed text", async () => {
    inboxRows = [
      {
        conversation_id: 9102,
        from_number: '555-0002',
        id: 77,
        citizenid: 'CID_B',
        message: await sealedFor('CID_B', 9102, 'Someone broke into my car'),
        external_sender: null,
        created_at: new Date('2026-10-05T21:40:00.000Z')
      },
      {
        conversation_id: 9101,
        from_number: null,
        id: 70,
        citizenid: 'CID_A',
        message: 'Units are on the way',
        external_sender: 'Emergency',
        created_at: '2026-10-05T21:30:00.000Z'
      }
    ];

    const reply = await call('lineInbox', { number: '911' });

    expect(reply).toEqual([
      {
        conversation_id: 9102,
        from: '555-0002',
        last_message: 'Someone broke into my car',
        last_at: '2026-10-05T21:40:00.000Z',
        awaiting_reply: true
      },
      {
        conversation_id: 9101,
        from: null,
        last_message: 'Units are on the way',
        last_at: '2026-10-05T21:30:00.000Z',
        awaiting_reply: false
      }
    ]);

    const [read] = ofStatement('c.participant_b = ?');
    expect(read.params).toEqual(['ext:911', JOB_LINE_INBOX_MAX]);
    expect(read.sql).toMatch(/ORDER BY m\.created_at DESC, m\.id DESC\s+LIMIT \?/);
    expect(read.sql).toContain("x.status = 'active'");
    expect(JOB_LINE_INBOX_MAX).toBe(50);
  });

  it('lets a second job that staffs the line open it too', async () => {
    await call('lineInbox', { number: '911' }, 4);
    expect(ofStatement('c.participant_b = ?')).toHaveLength(1);
  });
});

// ─── lineThread ──────────────────────────────────────────────────────────────

describe('lineThread (MICA-307)', () => {
  it('maps sides, opens sealed text, flags attachments without sending them', async () => {
    pageRows = [
      {
        id: 12,
        conversation_id: 9101,
        citizenid: 'CID_A',
        message: 'Units are on the way',
        external_sender: 'Emergency',
        created_at: '2026-10-05T21:31:00.000Z',
        has_attachments: 0
      },
      {
        id: 11,
        conversation_id: 9101,
        citizenid: 'CID_A',
        message: await sealedFor('CID_A', 9101, 'Shots fired near the pier'),
        external_sender: null,
        created_at: '2026-10-05T21:30:00.000Z',
        has_attachments: 1
      }
    ];

    const reply = await call('lineThread', { number: '911', conversation_id: 9101 });

    expect(reply).toEqual({
      rows: [
        {
          id: 12,
          conversation_id: 9101,
          side: 'line',
          message: 'Units are on the way',
          has_attachments: false,
          created_at: '2026-10-05T21:31:00.000Z'
        },
        {
          id: 11,
          conversation_id: 9101,
          side: 'caller',
          message: 'Shots fired near the pier',
          has_attachments: true,
          created_at: '2026-10-05T21:30:00.000Z'
        }
      ],
      nextCursor: null
    });
    // The attachment is never selected, only whether there was one.
    const [read] = ofStatement('a.message_id = m.id');
    expect(read.sql).not.toMatch(/mica_media|p\.data/);
  });

  it('pages by keyset on the thread named, like messages:get', async () => {
    pageRows = Array.from({ length: 4 }, (_, i) => ({
      id: 40 - i,
      conversation_id: 9101,
      citizenid: 'CID_A',
      message: `m${i}`,
      external_sender: null,
      created_at: '2026-10-05T21:30:00.000Z',
      has_attachments: 0
    }));

    const reply = await call('lineThread', {
      number: '911',
      conversation_id: 9101,
      cursor: 41,
      limit: 3
    });

    expect(reply.rows.map((row: any) => row.id)).toEqual([40, 39, 38]);
    expect(reply.nextCursor).toBe(38);
    const [read] = ofStatement('a.message_id = m.id');
    expect(read.params).toEqual([9101, 41, 4]);
    expect(read.sql).toContain('m.id < ?');
  });
});

// ─── lineReply ───────────────────────────────────────────────────────────────

describe('lineReply (MICA-307)', () => {
  it("lands in the thread's player's Messages as the line, never as the staff member", async () => {
    const reply = await call('lineReply', {
      number: '911',
      conversation_id: 9101,
      message: 'Units are on the way'
    });

    expect(sent.sendFromLine).toHaveBeenCalledWith(
      'CID_PLAYER',
      { name: 'Emergency', number: '911', blockable: false },
      'Units are on the way',
      []
    );
    expect(reply).toEqual({
      id: 555,
      conversation_id: 9101,
      side: 'line',
      message: 'Units are on the way',
      has_attachments: false,
      created_at: expect.any(String)
    });
  });

  it('names a line with no label by its number, as SendMessage would', async () => {
    (globalThis as any).GetConvar = (name: string, fallback: string) => {
      if (name === 'mica_content_key_file') return keyPath;
      if (name === 'mica_job_lines') return '[{"number":"911","jobs":["police"]}]';
      return fallback;
    };
    refreshJobLines();

    await call('lineReply', { number: '911', conversation_id: 9101, message: 'Hi' });

    expect(sent.sendFromLine).toHaveBeenCalledWith(
      'CID_PLAYER',
      { name: '911', number: '911', blockable: true },
      'Hi',
      []
    );
  });

  it('tells the other staff on shift, without a toast, and not the one who answered', async () => {
    await call('lineReply', { number: '911', conversation_id: 9101, message: 'Hi' });

    expect(pushes.pushMany).toHaveBeenCalledTimes(1);
    const [appId, citizenids, event, payload, options] = pushes.pushMany.mock.calls[0];
    expect([appId, citizenids, event, payload, options]).toEqual([
      'jobs',
      ['CID_COP2'],
      'line_message',
      { number: '911', conversation_id: 9101 },
      undefined
    ]);
  });

  it.each(['   ', '\n\t '])(
    'refuses a body that is only whitespace (%j), the way messages:send does',
    async (message) => {
      const reply = await call('lineReply', { number: '911', conversation_id: 9101, message });
      expect(refusalOf(reply)).toEqual({
        error: 'A message body or an attachment is required.',
        key: 'server.messages.bodyRequired'
      });
      expect(sent.sendFromLine).not.toHaveBeenCalled();
      expect(pushes.pushMany).not.toHaveBeenCalled();
    }
  );

  it('still tells a stranger only that the line is unavailable, whatever the body', async () => {
    const reply = await call(
      'lineReply',
      { number: '911', conversation_id: 9101, message: '   ' },
      3
    );
    expect(refusalOf(reply)).toEqual(REFUSAL);
  });

  it('still answers when the staff push throws', async () => {
    pushes.pushMany.mockImplementationOnce(() => {
      throw new Error('push broke');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reply = await call('lineReply', { number: '911', conversation_id: 9101, message: 'Hi' });

    expect(reply).toMatchObject({ id: 555, side: 'line' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("could not tell 911's staff"),
      expect.any(Error)
    );
  });
});

// ─── a text from a player ────────────────────────────────────────────────────

describe('a player texting a job line (MICA-307)', () => {
  /** Tell the line, then let `notifyIncoming`'s read and push land. */
  const textFrom = async (source: number, from: string | null, messageId = 80) => {
    const told = tellLine(lookupLine('911')!, {
      to: '911',
      from,
      source,
      citizenid: 'CID_CIV',
      body: 'help',
      conversationId: 9101,
      messageId
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return told;
  };

  it('pushes line_message to every staff member now, with a toast naming the line', async () => {
    expect(await textFrom(3, '555-0003')).toBe(true);

    expect(pushes.pushMany).toHaveBeenCalledTimes(1);
    const [appId, citizenids, event, payload, options] = pushes.pushMany.mock.calls[0];
    expect(appId).toBe('jobs');
    // Off duty (2), not police (3, 5) and police held but inactive (6) are not staff.
    expect(citizenids).toEqual(['CID_COP', 'CID_COP2']);
    expect(event).toBe('line_message');
    expect(payload).toEqual({ number: '911', conversation_id: 9101 });
    expect(options).toMatchObject({
      notify: { type: 'info', title: 'Text to Emergency', message: 'From 555-0003' },
      kind: 'line_message'
    });
    // The text itself is never in the toast or the persisted row (MICA-165).
    expect(JSON.stringify(options)).not.toContain('help');
  });

  it('does not tell the texter, when they are staff themselves', async () => {
    await textFrom(1, '555-0001');
    expect(pushes.pushMany.mock.calls[0][1]).toEqual(['CID_COP2']);
  });

  it('says so when the sender has no number', async () => {
    await textFrom(3, null);
    expect(pushes.pushMany.mock.calls[0][4].notify.message).toBe('From an unknown number');
  });

  it('pushes nothing when nobody is on shift', async () => {
    players.delete(1);
    players.delete(4);
    await textFrom(3, '555-0003');
    expect(pushes.pushMany).not.toHaveBeenCalled();
  });
});

describe('a job line notifies once per wait, not once per text (MICA-307)', () => {
  const textFrom = async (messageId: number) => {
    tellLine(lookupLine('911')!, {
      to: '911',
      from: '555-0003',
      source: 3,
      citizenid: 'CID_CIV',
      body: 'help',
      conversationId: 9101,
      messageId
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** The options of the n-th push: undefined is a silent refetch, else it carries `notify`. */
  const optionsOf = (n: number) => pushes.pushMany.mock.calls[n][4];

  it('notifies on the first text in a thread, which has no row before it', async () => {
    previousRow = null;
    await textFrom(80);
    expect(optionsOf(0)).toMatchObject({ notify: { message: 'From 555-0003' } });
    // The read is the row before this text, in this thread, by id.
    const [read] = ofStatement('SELECT m.external_sender FROM mica_messages m');
    expect(read.params).toEqual([9101, 80]);
    expect(read.sql).toContain('m.id < ?');
    expect(read.sql).not.toMatch(/m\.message\b/);
  });

  it('pushes a second text silently: the thread was already waiting', async () => {
    previousRow = { external_sender: null };
    await textFrom(81);
    expect(pushes.pushMany).toHaveBeenCalledTimes(1);
    expect(pushes.pushMany.mock.calls[0][2]).toBe('line_message');
    expect(optionsOf(0)).toBeUndefined();
  });

  it('notifies again on a text after a staff reply', async () => {
    previousRow = { external_sender: 'Emergency' };
    await textFrom(82);
    expect(optionsOf(0)).toMatchObject({ notify: { title: 'Text to Emergency' } });
  });

  it('runs first, second, reply, third in order: notify, silent, notify', async () => {
    previousRow = null;
    await textFrom(90);
    previousRow = { external_sender: null };
    await textFrom(91);
    previousRow = { external_sender: 'Emergency' };
    await textFrom(93);
    expect([
      optionsOf(0) !== undefined,
      optionsOf(1) !== undefined,
      optionsOf(2) !== undefined
    ]).toEqual([true, false, true]);
  });

  it('notifies when the read fails, and says why', async () => {
    previousRow = new Error('db down');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await textFrom(83);
    expect(optionsOf(0)).toMatchObject({ notify: { message: 'From 555-0003' } });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not read thread 9101 on 911'),
      expect.any(Error)
    );
  });
});
