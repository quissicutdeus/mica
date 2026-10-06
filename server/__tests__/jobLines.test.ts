// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

interface Job {
  name: string;
  active: boolean;
  onDuty: boolean | null;
}

/** Connected players by source, each with the jobs the framework would answer for them. */
const framework = vi.hoisted(() => ({
  players: new Map<number, { citizenid: string; jobs: Job[] }>(),
  /** Still in the player list, but `getPlayer` no longer answers: they have just dropped. */
  gone: new Set<number>(),
  phoneHolders: new Map<string, number>()
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getAllPlayers: () =>
      Object.fromEntries([
        ...[...framework.players].map(([src, p]) => [
          src,
          { PlayerData: { citizenid: p.citizenid } }
        ]),
        ...[...framework.gone].map((src) => [src, { PlayerData: { citizenid: `CID_${src}` } }])
      ]),
    getPlayer: (src: number) => {
      const player = framework.players.get(src);
      return player
        ? { source: src, citizenid: player.citizenid, getJobs: () => player.jobs }
        : null;
    },
    getPlayerByPhone: (phone: string) => {
      const src = framework.phoneHolders.get(phone);
      return src === undefined ? null : { source: src, citizenid: `CID_${src}` };
    }
  }
}));

import { parseJobLines, DEFAULT_MAX_RING, RING_MAX, type JobLine } from '../../shared/ownerConfig';
import { resolveJobLines } from '../lib/ownerConfig';
import {
  __resetJobLines,
  jobLineNumbers,
  refreshJobLines,
  staffFor,
  startJobLines,
  tickJobLines,
  SYNC_INTERVAL_MS
} from '../lib/jobLines';
import {
  __resetRegistry,
  askLine,
  linesForJob,
  lookupLine,
  registerNumber
} from '../lib/numberRegistry';

const line = (overrides: Partial<JobLine> = {}): JobLine => ({
  number: '911',
  label: 'Emergency',
  jobs: ['police'],
  requireDuty: true,
  maxRing: DEFAULT_MAX_RING,
  blockable: true,
  ...overrides
});

describe('parseJobLines (MICA-307)', () => {
  it('reads a full entry as written', () => {
    const raw = JSON.stringify([
      {
        number: '911',
        label: 'Emergency',
        jobs: ['police', 'sheriff'],
        requireDuty: false,
        maxRing: 4,
        blockable: false
      }
    ]);
    expect(parseJobLines(raw)).toEqual({
      value: [
        {
          number: '911',
          label: 'Emergency',
          jobs: ['police', 'sheriff'],
          requireDuty: false,
          maxRing: 4,
          blockable: false
        }
      ],
      rejected: []
    });
  });

  it('fills the defaults: no label, duty required, ten rung, blockable', () => {
    expect(parseJobLines('[{"number":"555-0911","jobs":["mechanic"]}]').value).toEqual([
      {
        number: '555-0911',
        label: null,
        jobs: ['mechanic'],
        requireDuty: true,
        maxRing: 10,
        blockable: true
      }
    ]);
  });

  it.each([1, 10, RING_MAX])('takes maxRing %s as written', (given) => {
    const raw = JSON.stringify([{ number: '911', jobs: ['police'], maxRing: given }]);
    expect(parseJobLines(raw).value[0].maxRing).toBe(given);
  });

  it.each([0, -5, 3.7, RING_MAX + 1, 1000])(
    'refuses maxRing %s loudly rather than clamping it',
    (given) => {
      const raw = JSON.stringify([
        { number: '911', jobs: ['police'], maxRing: given },
        { number: '912', jobs: ['ems'] }
      ]);
      const parsed = parseJobLines(raw);
      expect(parsed.value.map((l) => l.number)).toEqual(['912']);
      expect(parsed.rejected[0].reason).toBe(
        `"maxRing" must be a whole number from 1 to ${RING_MAX}`
      );
    }
  );

  it('dedupes jobs and trims the number and label, with a blank label read as none', () => {
    const raw = '[{"number":" 911 ","label":"  ","jobs":["police","police","ems"]}]';
    expect(parseJobLines(raw).value[0]).toMatchObject({
      number: '911',
      label: null,
      jobs: ['police', 'ems']
    });
  });

  it.each([
    ['not an object', '"911"', 'not an object'],
    ['an array entry', '["911"]', 'not an object'],
    ['no number', '{"jobs":["police"]}', '"number" is required'],
    ['a numeric number', '{"number":911,"jobs":["police"]}', '"number" is required'],
    ['a blank number', '{"number":" ","jobs":["police"]}', '"number" is required'],
    ['no jobs', '{"number":"911"}', '"jobs" is required'],
    ['empty jobs', '{"number":"911","jobs":[]}', '"jobs" is required'],
    ['jobs as a string', '{"number":"911","jobs":"police"}', '"jobs" is required'],
    ['an upper-case job', '{"number":"911","jobs":["Police"]}', 'lower_snake_case'],
    ['a job with a space', '{"number":"911","jobs":["state police"]}', 'lower_snake_case'],
    ['a numeric job', '{"number":"911","jobs":[1]}', 'lower_snake_case'],
    ['a label too long', `{"number":"911","jobs":["police"],"label":"${'x'.repeat(41)}"}`, '40'],
    ['a numeric label', '{"number":"911","jobs":["police"],"label":5}', '"label" must be'],
    [
      'requireDuty as a string',
      '{"number":"911","jobs":["police"],"requireDuty":"no"}',
      'true or false'
    ],
    ['blockable as a number', '{"number":"911","jobs":["police"],"blockable":0}', 'true or false'],
    ['maxRing as a string', '{"number":"911","jobs":["police"],"maxRing":"5"}', 'whole number'],
    ['a misspelt key', '{"number":"911","jobs":["police"],"requireduty":false}', '"requireduty"']
  ])('refuses %s, naming why, and keeps the other entries', (_label, entry, why) => {
    const parsed = parseJobLines(`[${entry}, {"number":"912","jobs":["ems"]}]`);
    expect(parsed.value.map((l) => l.number)).toEqual(['912']);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toContain(why);
  });

  it('accepts a label of exactly 40 characters', () => {
    const raw = JSON.stringify([{ number: '911', jobs: ['police'], label: 'x'.repeat(40) }]);
    expect(parseJobLines(raw).value[0].label).toHaveLength(40);
  });

  it('refuses a second entry for a number already taken', () => {
    const parsed = parseJobLines(
      '[{"number":"911","jobs":["police"]},{"number":"911","jobs":["ems"]}]'
    );
    expect(parsed.value).toEqual([expect.objectContaining({ jobs: ['police'] })]);
    expect(parsed.rejected[0].reason).toContain('already has "911"');
  });

  it('reads unset or blank as no lines, and refuses a document that is not an array whole', () => {
    expect(parseJobLines('')).toEqual({ value: [], rejected: [] });
    expect(parseJobLines('   ')).toEqual({ value: [], rejected: [] });
    expect(parseJobLines('{"number":"911"}').rejected[0].reason).toBe('not a JSON array');
    expect(parseJobLines('[{').rejected[0].reason).toBe('not valid JSON');
  });
});

describe('resolveJobLines: inline or a file (MICA-307)', () => {
  const ENTRY = '[{"number":"911","jobs":["police"]}]';

  it('reads inline JSON without touching the loader', () => {
    const load = vi.fn();
    expect(resolveJobLines(` ${ENTRY} `, load).value.map((l) => l.number)).toEqual(['911']);
    expect(load).not.toHaveBeenCalled();
  });

  it('reads a path inside the resource through the loader', () => {
    const load = vi.fn(() => ENTRY);
    const resolved = resolveJobLines('config/job_lines.json', load);
    expect(load).toHaveBeenCalledWith('config/job_lines.json');
    expect(resolved).toMatchObject({ problem: null, rejected: [] });
    expect(resolved.value.map((l) => l.number)).toEqual(['911']);
  });

  it.each(['/etc/lines.json', 'C:/lines.json', '../other/lines.json'])(
    'refuses %s as outside the resource, before reading it',
    (path) => {
      const load = vi.fn(() => ENTRY);
      expect(resolveJobLines(path, load).problem).toContain('not a path inside this resource');
      expect(load).not.toHaveBeenCalled();
    }
  );

  it('reports a file it cannot read as a problem, never a throw', () => {
    const throws = () => {
      throw new Error('boom');
    };
    expect(resolveJobLines('lines.json', throws).problem).toBe(
      "could not read 'lines.json' from this resource"
    );
    expect(resolveJobLines('lines.json', () => null).problem).toContain('could not read');
  });

  it('names the file, not its contents, when the whole document is refused', () => {
    expect(resolveJobLines('lines.json', () => '{"oops":1}').problem).toBe(
      "'lines.json' is not a JSON array"
    );
    expect(resolveJobLines('[1', () => null).problem).toBe('the value is not valid JSON');
  });

  it('says an entry written inline without its brackets is not an array, not a path', () => {
    const load = vi.fn(() => null);
    expect(resolveJobLines(' {"number":"911","jobs":["police"]} ', load).problem).toBe(
      'inline JSON must be an array; wrap the entry in [ ]'
    );
    expect(load).not.toHaveBeenCalled();
  });
});

describe('staffFor (MICA-307)', () => {
  beforeEach(() => framework.players.clear());

  const add = (src: number, ...jobs: Job[]) =>
    framework.players.set(src, { citizenid: `CID_${src}`, jobs });

  const police = (over: Partial<Job> = {}): Job => ({
    name: 'police',
    active: true,
    onDuty: true,
    ...over
  });

  it('rings an on-duty member holding the job as the active one', () => {
    add(3, police());
    expect(staffFor(line(), 1)).toEqual([3]);
  });

  it('skips a member holding the job when another job is the active one', () => {
    add(3, { name: 'mechanic', active: true, onDuty: true }, police({ active: false }));
    expect(staffFor(line(), 1)).toEqual([]);
  });

  it('skips a member who is off duty', () => {
    add(3, police({ onDuty: false }));
    expect(staffFor(line(), 1)).toEqual([]);
  });

  it('counts a member whose framework cannot say whether they are on duty', () => {
    add(3, police({ onDuty: null }));
    expect(staffFor(line(), 1)).toEqual([3]);
  });

  it('rings off-duty members when the line does not require duty', () => {
    add(3, police({ onDuty: false }));
    expect(staffFor(line({ requireDuty: false }), 1)).toEqual([3]);
  });

  it('still skips an inactive job when the line does not require duty', () => {
    add(3, police({ active: false, onDuty: false }));
    expect(staffFor(line({ requireDuty: false }), 1)).toEqual([]);
  });

  it('matches any of the line jobs, never the caller, in ascending source order', () => {
    add(9, { name: 'sheriff', active: true, onDuty: true });
    add(4, police());
    add(1, police());
    add(6, { name: 'ems', active: true, onDuty: true });
    expect(staffFor(line({ jobs: ['police', 'sheriff'] }), 1)).toEqual([4, 9]);
  });

  it('returns every eligible member, uncapped: maxRing is applied after the busy filter', () => {
    for (const src of [8, 3, 5, 2, 7]) add(src, police());
    expect(staffFor(line({ maxRing: 3 }), 1)).toEqual([2, 3, 5, 7, 8]);
  });

  it('skips a source the framework no longer answers for', () => {
    add(3, police());
    framework.gone.add(2);
    try {
      expect(staffFor(line(), 1)).toEqual([3]);
    } finally {
      framework.gone.clear();
    }
  });

  it('skips a player whose jobs cannot be read, and says so', () => {
    add(3, police());
    framework.players.set(4, {
      citizenid: 'CID_4',
      get jobs(): Job[] {
        throw new Error('framework broke');
      }
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(staffFor(line(), 1)).toEqual([3]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not read jobs for player 4'),
      expect.any(Error)
    );
    error.mockRestore();
  });
});

describe('job line sync (MICA-307)', () => {
  let convar = '';
  const errors: string[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    __resetRegistry();
    __resetJobLines();
    framework.players.clear();
    framework.phoneHolders.clear();
    convar = '';
    errors.length = 0;
    logs.length = 0;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_job_lines' ? convar : fallback;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    __resetJobLines();
    vi.restoreAllMocks();
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
  });

  const set = (...entries: object[]) => {
    convar = JSON.stringify(entries);
  };

  it('registers each entry at start under this resource, and says which', () => {
    set({ number: '911', jobs: ['police'] }, { number: '555-0100', jobs: ['mechanic'] });
    startJobLines();

    expect(lookupLine('911')?.owner).toBe('mica');
    expect(lookupLine('555-0100')?.owner).toBe('mica');
    expect(logs).toContain('mica: job lines -> 2 registered (911, 555-0100)');
  });

  it('says none are registered when nothing is configured', () => {
    startJobLines();
    expect(logs).toContain('mica: job lines -> none registered');
    expect(jobLineNumbers()).toEqual([]);
  });

  it('answers a call with ring over the staff, or reject when there are none', async () => {
    set({ number: '911', jobs: ['police'], label: 'Emergency', blockable: false });
    startJobLines();
    const registered = lookupLine('911')!;
    expect(registered).toMatchObject({ label: 'Emergency', blockable: false });

    const incoming = { from: '555-0001', source: 1, callId: 7 };
    await expect(askLine(registered, incoming)).resolves.toEqual({ action: 'reject' });

    framework.players.set(4, {
      citizenid: 'CID_4',
      jobs: [{ name: 'police', active: true, onDuty: true }]
    });
    await expect(askLine(registered, incoming)).resolves.toEqual({
      action: 'ring',
      sources: [4],
      max: DEFAULT_MAX_RING
    });
  });

  it('hands every staff member to the verdict, with maxRing as its max', async () => {
    set({ number: '911', jobs: ['police'], maxRing: 10 });
    startJobLines();
    for (let src = 2; src <= 13; src++) {
      framework.players.set(src, {
        citizenid: `CID_${src}`,
        jobs: [{ name: 'police', active: true, onDuty: true }]
      });
    }
    const verdict = await askLine(lookupLine('911')!, {
      from: '555-0001',
      source: 1,
      callId: 7
    });
    expect(verdict).toEqual({
      action: 'ring',
      sources: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      max: 10
    });
  });

  it('lists a line staffed by several jobs under each of them in the Jobs app', () => {
    set({ number: '911', jobs: ['police', 'sheriff'] });
    startJobLines();
    expect(linesForJob('police').map((l) => l.number)).toEqual(['911']);
    expect(linesForJob('sheriff').map((l) => l.number)).toEqual(['911']);
    expect(linesForJob('ems')).toEqual([]);
  });

  it('refuses a malformed entry loudly, naming it and why, and registers the rest', () => {
    set({ number: '911', jobs: ['police'] }, { number: '912' });
    startJobLines();

    expect(jobLineNumbers()).toEqual(['911']);
    expect(errors).toEqual([
      expect.stringMatching(/mica_job_lines: refusing \{"number":"912"\}: "jobs" is required/)
    ]);
  });

  it('skips a number a script already holds, naming the holder, and leaves the script its line', () => {
    const scriptCall = () => ({ action: 'accept' }) as const;
    registerNumber('911', { onCall: scriptCall }, 'cd_dispatch');
    set({ number: '911', jobs: ['police'] }, { number: '912', jobs: ['ems'] });
    startJobLines();

    expect(lookupLine('911')?.owner).toBe('cd_dispatch');
    expect(lookupLine('911')?.onCall).toBe(scriptCall);
    expect(jobLineNumbers()).toEqual(['912']);
    expect(errors.join('\n')).toMatch(/not registering .*"911".*cd_dispatch already holds/);
  });

  it('skips a number a character holds', () => {
    framework.phoneHolders.set('911', 5);
    set({ number: '911', jobs: ['police'] });
    startJobLines();

    expect(lookupLine('911')).toBeUndefined();
    expect(errors.join('\n')).toMatch(/not registering .*A character already holds/);
  });

  it('refuses a number in a shape the registry does not take, loudly', () => {
    set({ number: 'Downtown Cab', jobs: ['taxi'] });
    startJobLines();
    expect(lookupLine('Downtown Cab')).toBeUndefined();
    expect(errors.join('\n')).toMatch(/not registering .*Downtown Cab.*digits/);
  });

  it('re-syncs on a changed value: removes, adds, and leaves an unchanged line alone', () => {
    set({ number: '911', jobs: ['police'] }, { number: '912', jobs: ['ems'] });
    startJobLines();
    const kept = lookupLine('911');

    set({ number: '911', jobs: ['police'] }, { number: '555-0100', jobs: ['mechanic'] });
    refreshJobLines();

    expect(lookupLine('911')).toBe(kept);
    expect(lookupLine('912')).toBeUndefined();
    expect(lookupLine('555-0100')?.owner).toBe('mica');
    expect(jobLineNumbers().sort()).toEqual(['555-0100', '911']);
  });

  it('re-registers a line whose entry changed', () => {
    set({ number: '911', jobs: ['police'] });
    startJobLines();
    const before = lookupLine('911');

    set({ number: '911', jobs: ['police', 'sheriff'], label: 'Emergency' });
    refreshJobLines();

    expect(lookupLine('911')).not.toBe(before);
    expect(lookupLine('911')).toMatchObject({ label: 'Emergency', jobs: ['police', 'sheriff'] });
  });

  it('takes every line down when the value is cleared', () => {
    set({ number: '911', jobs: ['police'] });
    startJobLines();
    convar = '';
    refreshJobLines();
    expect(lookupLine('911')).toBeUndefined();
    expect(jobLineNumbers()).toEqual([]);
  });

  it('does nothing when the raw value is unchanged', () => {
    set({ number: '911', jobs: ['police'], label: 'Emergency' });
    startJobLines();
    const before = lookupLine('911');
    errors.length = 0;

    refreshJobLines();
    refreshJobLines();

    expect(lookupLine('911')).toBe(before);
    expect(errors).toEqual([]);
  });

  it('never unregisters a number another resource holds, even one it once held', () => {
    set({ number: '911', jobs: ['police'] });
    startJobLines();
    // A script cannot take a held number, so the only way here is micaOS losing it first;
    // the sweep on resource stop is that path.
    convar = '';
    refreshJobLines();
    registerNumber('911', { onCall: () => ({ action: 'accept' }) as const }, 'cd_dispatch');

    set({ number: '912', jobs: ['ems'] });
    refreshJobLines();

    expect(lookupLine('911')?.owner).toBe('cd_dispatch');
  });

  it('checks the value at most once per interval on the tick', () => {
    set({ number: '911', jobs: ['police'] });
    const start = Date.now();
    tickJobLines(start + SYNC_INTERVAL_MS);
    expect(jobLineNumbers()).toEqual(['911']);

    set({ number: '912', jobs: ['ems'] });
    tickJobLines(start + SYNC_INTERVAL_MS + 1);
    expect(jobLineNumbers()).toEqual(['911']);

    tickJobLines(start + 2 * SYNC_INTERVAL_MS + 1);
    expect(jobLineNumbers()).toEqual(['912']);
  });

  it('logs a value it cannot read at all as one problem, and registers nothing', () => {
    convar = '[{"number":"911"';
    startJobLines();
    expect(jobLineNumbers()).toEqual([]);
    expect(errors).toEqual([
      expect.stringContaining('mica_job_lines: the value is not valid JSON. No job lines')
    ]);
  });
});
