// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-329: one failed notification insert does not drop every later recipient's.
 *
 * `createNotificationBatch` awaited each INSERT with no catch, so the first one to throw ended
 * the loop, and `appEvents.ts` swallowed the rejection with `.catch(() => {})`: nobody after
 * the failing recipient got a stored notification, and nothing said so.
 *
 * Failures are thrown in oxmysql's shape — the statement and its parameters, then the driver's
 * reason on the last line — because that is what puts a notification's body into an error
 * message, and the log must carry the reason without it.
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => null,
    getCitizenId: () => null,
    registerUsableItem: () => {},
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: (ids: readonly string[]) => new Map(ids.map((id, i) => [id, 10 + i]))
  }
}));

import {
  getNotificationsRepository,
  notificationFailureReason,
  UNKNOWN_DB_ERROR
} from '../services/Notifications';
import { appEventChannel } from '../lib/appEvents';

const BODY = 'a private preview nobody else should read';
const CITIZENS = ['CID_1', 'CID_2', 'CID_3', 'CID_4'];

/** What oxmysql's `query` export rejects with: the statement and parameters, reason last. */
const oxmysqlError = (
  params: unknown,
  reason = "Data too long for column 'title' at row 1"
): Error =>
  new Error(
    'mica was unable to execute a query!\n' +
      'Query: INSERT INTO mica_notifications (citizenid, ...) VALUES (?, ...)\n' +
      `${JSON.stringify(params)}\n` +
      reason
  );

const INSERT = 'INSERT INTO mica_notifications';

/** Item 2 of 4 fails; every other insert succeeds. */
const failSecondRecipient = () => {
  dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (String(sql).startsWith(INSERT) && params[0] === 'CID_2') throw oxmysqlError(params);
    return { affectedRows: 1 };
  });
};

const storedFor = (): unknown[] =>
  dbMock.query.mock.calls
    .filter((call: unknown[]) => String(call[0]).startsWith(INSERT))
    .map((call: unknown[]) => (call[1] as unknown[])[0]);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dbMock.query.mockReset();
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  (globalThis as any).emitNet = vi.fn();
});

afterEach(() => {
  error.mockRestore();
});

const items = () =>
  CITIZENS.map((citizenid) => ({
    citizenid,
    app: 'mail',
    kind: 'email',
    title: 'Email from Bank',
    body: BODY
  }));

describe('createNotificationBatch', () => {
  it('stores the recipients after a failed one, and says so once with the count', async () => {
    failSecondRecipient();

    await getNotificationsRepository()!.createNotificationBatch(items());

    expect(storedFor()).toEqual(CITIZENS); // all four attempted, 3 and 4 included
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toMatch(/could not store 1 of 4 'mail:email' notification\(s\)/);
    expect(line).toMatch(/Data too long for column 'title'/);
  });

  it('never logs the body, even though the driver error carries it', async () => {
    failSecondRecipient();

    await getNotificationsRepository()!.createNotificationBatch(items());

    const everything = error.mock.calls.flat().map(String).join('\n');
    expect(everything).not.toContain(BODY);
    expect(everything).not.toContain('Query:');
  });

  it('counts every failure but reports only the first reason', async () => {
    dbMock.query.mockRejectedValue(new Error('connection lost'));

    await getNotificationsRepository()!.createNotificationBatch(items());

    expect(storedFor()).toHaveLength(4);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/4 of 4 .*connection lost/);
  });

  it('logs nothing when every insert succeeds', async () => {
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    await getNotificationsRepository()!.createNotificationBatch(items());

    expect(storedFor()).toEqual(CITIZENS);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a push whose notification store fails', () => {
  const notify = { title: 'Email from Bank', message: BODY };

  it('still delivers, and the later recipients are still stored', async () => {
    failSecondRecipient();

    const outcome = appEventChannel('mail').pushMany(CITIZENS, 'email', {}, { notify });
    await flush();

    expect(outcome.delivered).toEqual(CITIZENS);
    expect(storedFor()).toEqual(CITIZENS);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('logs a rejection the batch did not catch, without failing the push', async () => {
    const repo = getNotificationsRepository()!;
    const batch = vi
      .spyOn(repo, 'createNotificationBatch')
      .mockRejectedValue(oxmysqlError(['CID_1', BODY]));

    const outcome = appEventChannel('mail').push('CID_1', 'email', {}, { notify });
    await flush();

    expect(outcome.delivered).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toMatch(/\[appEvents\] could not store 'mail:email' notification\(s\) for 1/);
    expect(line).not.toContain(BODY);
    batch.mockRestore();
  });
});

describe('notificationFailureReason', () => {
  it('answers the constant when the driver reason is empty, never the parameters', async () => {
    // Node's dual-stack ECONNREFUSED is an AggregateError with message '', so oxmysql's
    // string ends with the parameters line and a blank one.
    dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (String(sql).startsWith(INSERT)) throw oxmysqlError(params, '');
      return { affectedRows: 1 };
    });

    await getNotificationsRepository()!.createNotificationBatch(items());

    const everything = error.mock.calls.flat().map(String).join('\n');
    expect(everything).not.toContain(BODY);
    expect(everything).toContain(UNKNOWN_DB_ERROR);
  });

  it.each([
    ['an array parameters line', oxmysqlError(['CID_1', BODY], '')],
    ['an object parameters line', oxmysqlError({ body: BODY }, '')],
    ['a query line', new Error(`mica was unable to execute a query!\nQuery: SELECT '${BODY}'`)],
    ['only the header', new Error('mica was unable to execute a query!\n\n')],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a plain object', { message: BODY }],
    ['an Error with no message', new Error()]
  ])('answers the constant for %s', (_label, thrown) => {
    expect(notificationFailureReason(thrown)).toBe(UNKNOWN_DB_ERROR);
  });

  it('keeps the driver reason, and a message that is not oxmysql-shaped', () => {
    expect(notificationFailureReason(oxmysqlError(['CID_1', BODY]))).toBe(
      "Data too long for column 'title' at row 1"
    );
    expect(notificationFailureReason(new Error('connection lost'))).toBe('connection lost');
  });
});
