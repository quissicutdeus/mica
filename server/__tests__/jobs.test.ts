// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

/**
 * A fake `FrameworkPlayer` whose job list is a plain array the test edits, with spies on the
 * two setters. The setters mutate the list the way a framework would, so a success answer can
 * be checked against a *re-read* rather than against the request.
 */
const fake = vi.hoisted(() => {
  const state = {
    jobs: [] as Array<{
      name: string;
      label: string;
      grade: number;
      gradeLabel: string;
      salary: number;
      onDuty: boolean | null;
      isBoss: boolean;
      active: boolean;
    }>,
    setActiveJob: vi.fn((name: string) => {
      for (const job of state.jobs) job.active = job.name === name;
      return true;
    }),
    setDuty: vi.fn((name: string, onDuty: boolean) => {
      const job = state.jobs.find((j) => j.name === name);
      if (job) job.onDuty = onDuty;
      return true;
    })
  };
  return state;
});
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      src === 1
        ? {
            citizenid: 'CID_CALLER',
            source: 1,
            getJobs: () => fake.jobs.map((job) => ({ ...job })),
            setActiveJob: fake.setActiveJob,
            setDuty: fake.setDuty
          }
        : null
  }
}));

const banking = vi.hoisted(() => ({ getSocietyBalance: vi.fn((_job: string) => 12_500) }));
vi.mock('../lib/BankingBridge', () => ({ BankingBridge: banking }));

const registry = vi.hoisted(() => ({
  lines: [] as Array<{ number: string; label: string | null; job: string | null }>
}));
vi.mock('../lib/numberRegistry', () => ({
  linesForJob: (job: string) => registry.lines.filter((line) => line.job === job)
}));

import '../services/Jobs';
import { __resetRateLimits } from '../lib/rateLimit';

const EVENT = (action: string) => `mica:server:jobs:${action}`;

const call = async (action: string, data: unknown, src = 1) => {
  (globalThis as any).source = src;
  (globalThis as any).emitNet = vi.fn();
  const handler = handlers.get(EVENT(action));
  if (!handler) throw new Error(`no handler for ${action}`);
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

const police = {
  name: 'police',
  label: 'LSPD',
  grade: 3,
  gradeLabel: 'Sergeant',
  salary: 250,
  onDuty: true,
  isBoss: false,
  active: true
};
const taxi = {
  name: 'taxi',
  label: 'Downtown Cab',
  grade: 0,
  gradeLabel: 'Driver',
  salary: 50,
  onDuty: false,
  isBoss: false,
  active: false
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  fake.jobs = [{ ...police }, { ...taxi }];
  registry.lines = [];
  banking.getSocietyBalance.mockReturnValue(12_500);
});

describe('jobs: what is registered', () => {
  it('registers the three contracted actions and no generic CRUD', () => {
    // §2.9: a registered net event is reachable whether or not the app calls it, and there
    // is no table for a generic action to act on.
    const registered = [...handlers.keys()].filter((e) => e.startsWith('mica:server:jobs:'));
    expect(registered.toSorted()).toEqual([
      EVENT('getJobs'),
      EVENT('setActiveJob'),
      EVENT('setDuty')
    ]);
  });
});

describe('jobs: getJobs', () => {
  it('answers the framework list with lines and a null society balance for a non-boss', async () => {
    registry.lines = [
      { number: '555-0100', label: 'Dispatch', job: 'police' },
      { number: '555-0101', label: null, job: 'police' },
      { number: '555-0200', label: 'Rank', job: 'taxi' }
    ];

    const reply = await call('getJobs', undefined);

    expect(reply).toEqual([
      {
        ...police,
        lines: [
          { number: '555-0100', label: 'Dispatch' },
          { number: '555-0101', label: '555-0101' }
        ],
        societyBalance: null
      },
      { ...taxi, lines: [{ number: '555-0200', label: 'Rank' }], societyBalance: null }
    ]);
    expect(banking.getSocietyBalance).not.toHaveBeenCalled();
  });

  it('reads a society balance only for a boss, and only under that job name', async () => {
    fake.jobs = [{ ...police, isBoss: true }, { ...taxi }];

    const reply = await call('getJobs', undefined);

    expect(banking.getSocietyBalance).toHaveBeenCalledTimes(1);
    expect(banking.getSocietyBalance).toHaveBeenCalledWith('police');
    expect(reply[0].societyBalance).toBe(12_500);
    expect(reply[1].societyBalance).toBeNull();
  });

  it('passes a null balance through when no banking resource can answer', async () => {
    fake.jobs = [{ ...police, isBoss: true }];
    banking.getSocietyBalance.mockReturnValue(null);

    const reply = await call('getJobs', undefined);

    expect(reply[0].societyBalance).toBeNull();
  });

  it('answers an empty list for a player with no jobs', async () => {
    fake.jobs = [];
    expect(await call('getJobs', undefined)).toEqual([]);
  });

  it('refuses a steered payload, since nothing in it is read', async () => {
    const reply = await call('getJobs', { name: 'police' });
    expect(reply).toMatchObject({ error: expect.any(String) });
  });
});

describe('jobs: setActiveJob', () => {
  it('refuses a name outside the held list without ever reaching the framework', async () => {
    const reply = await call('setActiveJob', { name: 'mechanic' });

    expect(reply).toEqual({ ok: false, reason: 'unknown_job' });
    expect(fake.setActiveJob).not.toHaveBeenCalled();
    expect(banking.getSocietyBalance).not.toHaveBeenCalled();
  });

  it('compares exactly: case and whitespace are not a match', async () => {
    for (const name of ['Police', 'POLICE', ' police', 'police ']) {
      const reply = await call('setActiveJob', { name });
      expect(reply, name).toEqual({ ok: false, reason: 'unknown_job' });
    }
    expect(fake.setActiveJob).not.toHaveBeenCalled();
  });

  it('switches a held job and answers the re-read list', async () => {
    const reply = await call('setActiveJob', { name: 'taxi' });

    expect(fake.setActiveJob).toHaveBeenCalledWith('taxi');
    expect(reply.ok).toBe(true);
    expect(reply.jobs.map((j: any) => [j.name, j.active])).toEqual([
      ['police', false],
      ['taxi', true]
    ]);
  });

  it('answers refused when the framework did not take the switch', async () => {
    fake.setActiveJob.mockReturnValueOnce(false);

    const reply = await call('setActiveJob', { name: 'taxi' });

    expect(reply).toEqual({ ok: false, reason: 'refused' });
  });

  it('rejects a missing or malformed name before the handler runs', async () => {
    for (const data of [undefined, {}, { name: '' }, { name: 42 }, { name: 'x'.repeat(65) }]) {
      const reply = await call('setActiveJob', data);
      expect(reply, JSON.stringify(data)).toMatchObject({ error: expect.any(String) });
    }
    expect(fake.setActiveJob).not.toHaveBeenCalled();
  });
});

describe('jobs: setDuty', () => {
  it('refuses a name outside the held list without ever reaching the framework', async () => {
    const reply = await call('setDuty', { name: 'mechanic', onDuty: true });

    expect(reply).toEqual({ ok: false, reason: 'unknown_job' });
    expect(fake.setDuty).not.toHaveBeenCalled();
  });

  it('answers unsupported for a job with no duty notion, even the active one', async () => {
    fake.jobs = [{ ...police, onDuty: null }, { ...taxi }];

    const reply = await call('setDuty', { name: 'police', onDuty: true });

    expect(reply).toEqual({ ok: false, reason: 'unsupported' });
    expect(fake.setDuty).not.toHaveBeenCalled();
  });

  it('answers not_active for a held job that is not the active one', async () => {
    const reply = await call('setDuty', { name: 'taxi', onDuty: true });

    expect(reply).toEqual({ ok: false, reason: 'not_active' });
    expect(fake.setDuty).not.toHaveBeenCalled();
  });

  it('clocks the active job off and answers the re-read list', async () => {
    const reply = await call('setDuty', { name: 'police', onDuty: false });

    expect(fake.setDuty).toHaveBeenCalledWith('police', false);
    expect(reply.ok).toBe(true);
    expect(reply.jobs[0]).toMatchObject({ name: 'police', onDuty: false });
  });

  it('answers refused when the framework did not take the change', async () => {
    fake.setDuty.mockReturnValueOnce(false);

    const reply = await call('setDuty', { name: 'police', onDuty: false });

    expect(reply).toEqual({ ok: false, reason: 'refused' });
  });

  it('rejects a non-boolean onDuty before the handler runs', async () => {
    for (const onDuty of [undefined, 'true', 1, null]) {
      const reply = await call('setDuty', { name: 'police', onDuty });
      expect(reply, String(onDuty)).toMatchObject({ error: expect.any(String) });
    }
    expect(fake.setDuty).not.toHaveBeenCalled();
  });
});

describe('jobs: authentication', () => {
  it('refuses a source with no loaded character', async () => {
    const reply = await call('getJobs', undefined, 2);
    expect(reply).toMatchObject({ error: 'Player not authenticated' });
  });
});
