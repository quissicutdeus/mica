// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-227: every job a player holds, on `FrameworkPlayer`, verified by re-read.
 *
 * Nothing here can prove a framework behaves as its source says — that needs a running
 * server. What is provable is the rule every setter follows: the call's return value is never
 * the answer, the framework's own state read back afterwards is. So each fixture below keeps
 * its state on the same object the adapter reads, and the interesting cases are the ones where
 * a setter *claims* success and the state says otherwise.
 *
 * `FrameworkBridge` imports `Database` for the offline lookups, and `Database` reads
 * `exports.oxmysql` in module scope, so it is mocked (AGENTS.md §1).
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  FrameworkBridge,
  STANDALONE_CONVAR,
  __setResourceLookup,
  __resetStandaloneWarnings
} from '../lib/FrameworkBridge';
import { esxAdapter } from '../lib/framework/esx';
import { qbAdapter } from '../lib/framework/qb';
import { qbxAdapter } from '../lib/framework/qbx';
import { standaloneAdapter } from '../lib/framework/standalone';
import { __resetAssignedNumbers } from '../lib/phoneNumbers';

const useResources = (map: Record<string, unknown>) =>
  __setResourceLookup((name) => (map as Record<string, any>)[name]);

const errors = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

/** The convar the standalone adapter reads. `undefined` means the operator never set it. */
const setConvar = (value?: string) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === STANDALONE_CONVAR && value !== undefined ? value : fallback;
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetStandaloneWarnings();
  __resetAssignedNumbers();
  setConvar();
});

afterEach(() => {
  __setResourceLookup();
  delete (globalThis as any).GetConvar;
  delete (globalThis as any).GetPlayerIdentifierByType;
});

/* ── qbx_core ──────────────────────────────────────────────────────────────────────────── */

/** The job definitions `exports.qbx_core:GetJob` answers with (`server/groups.lua:273`). */
const QBX_JOBS: Record<string, any> = {
  police: {
    label: 'LSPD',
    defaultDuty: true,
    grades: {
      0: { name: 'Recruit', payment: 50 },
      2: { name: 'Sergeant', payment: 150 },
      4: { name: 'Chief', payment: 300, isboss: true }
    }
  },
  taxi: { label: 'Downtown Cab Co.', grades: { 0: { name: 'Driver', payment: 40 } } },
  mechanic: {
    label: 'Bennys',
    grades: {
      0: { name: 'Apprentice', payment: 30 },
      1: { name: 'Owner', payment: 90, isboss: true }
    }
  }
};

/** `PlayerData.job` as `toPlayerJob` builds it (`server/player.lua:217`). */
const qbxActive = (name: string, level: number, onduty = true) => {
  const def = QBX_JOBS[name];
  return {
    name,
    label: def.label,
    isboss: def.grades[level]?.isboss ?? false,
    onduty,
    payment: def.grades[level]?.payment ?? 0,
    grade: { name: def.grades[level]?.name, level }
  };
};

interface QbxOptions {
  /** Whether the resource exposes `GetJob` at all. */
  getJob?: boolean;
  /** Whether the resource exposes the two setters as exports. */
  exportsSetters?: boolean;
  /** What `SetPlayerPrimaryJob` does to the player — the honest one mutates. */
  primary?: 'honest' | 'liar';
  /** What `SetJobDuty` does — the honest one mutates, the liar answers true and does not. */
  duty?: 'honest' | 'liar' | 'shapeless';
}

/** A qbx_core with one loaded player holding three jobs, police active at grade 2. */
const qbx = (opts: QbxOptions = {}) => {
  const player: any = {
    PlayerData: {
      citizenid: 'CIT_QBX',
      charinfo: {},
      job: qbxActive('police', 2),
      jobs: { police: 2, taxi: 0, mechanic: 1 }
    },
    Functions: {
      SetJobDuty: vi.fn((onDuty: boolean) => {
        player.PlayerData.job.onduty = onDuty;
      })
    }
  };

  const core: Record<string, any> = { GetPlayer: () => player };
  if (opts.getJob !== false) core.GetJob = vi.fn((name: string) => QBX_JOBS[name]);
  if (opts.exportsSetters !== false) {
    core.SetPlayerPrimaryJob = vi.fn((citizenid: string, name: string) => {
      if (citizenid !== 'CIT_QBX') return false;
      if (opts.primary !== 'liar') {
        player.PlayerData.job = qbxActive(name, player.PlayerData.jobs[name]);
      }
      return true;
    });
    core.SetJobDuty = vi.fn((_src: number, onDuty: boolean) => {
      if (opts.duty === 'shapeless') player.PlayerData.job.onduty = Promise.resolve(onDuty);
      else if (opts.duty !== 'liar') player.PlayerData.job.onduty = onDuty;
      return true;
    });
  }

  useResources({ qbx_core: core });
  return { player, core };
};

describe('qbx_core', () => {
  it('lists every held job, the active one first, with grades from GetJob', () => {
    qbx();
    const jobs = FrameworkBridge.getPlayer(1)!.getJobs();

    expect(jobs.map((job) => job.name)).toEqual(['police', 'mechanic', 'taxi']);
    expect(jobs[0]).toEqual({
      name: 'police',
      label: 'LSPD',
      grade: 2,
      gradeLabel: 'Sergeant',
      salary: 150,
      onDuty: true,
      isBoss: false,
      active: true
    });
    expect(jobs[1]).toEqual({
      name: 'mechanic',
      label: 'Bennys',
      grade: 1,
      gradeLabel: 'Owner',
      salary: 90,
      // Duty lives on `PlayerData.job` alone; a held-but-inactive job has none to read.
      onDuty: null,
      isBoss: true,
      active: false
    });
    expect(jobs[2]).toMatchObject({ name: 'taxi', grade: 0, gradeLabel: 'Driver', salary: 40 });
    expect(jobs.filter((job) => job.active)).toHaveLength(1);
  });

  it('falls back to the grade number and the name when GetJob knows nothing', () => {
    const { player } = qbx();
    player.PlayerData.jobs.smuggler = 3;

    const smuggler = FrameworkBridge.getPlayer(1)!
      .getJobs()
      .find((job) => job.name === 'smuggler');
    expect(smuggler).toMatchObject({ label: 'smuggler', grade: 3, gradeLabel: '3', salary: 0 });
  });

  it('degrades to the one active job on a build without GetJob', () => {
    qbx({ getJob: false });
    const jobs = FrameworkBridge.getPlayer(1)!.getJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'police', active: true, onDuty: true });
    expect(qbxAdapter.jobSupport().multiJob).toBe(false);
  });

  it('answers [] for a player with no job at all, never a placeholder', () => {
    const { player } = qbx();
    player.PlayerData.job = undefined;
    expect(FrameworkBridge.getPlayer(1)!.getJobs()).toEqual([]);
  });

  it('switches the active job and believes the re-read, not the return value', () => {
    const { player, core } = qbx();
    const fp = FrameworkBridge.getPlayer(1)!;

    expect(fp.setActiveJob('taxi')).toBe(true);
    expect(core.SetPlayerPrimaryJob).toHaveBeenCalledWith('CIT_QBX', 'taxi');
    expect(player.PlayerData.job.name).toBe('taxi');
    expect(fp.getJobs()[0]).toMatchObject({ name: 'taxi', active: true });
  });

  it('reports false when SetPlayerPrimaryJob claims success and changes nothing', () => {
    const { player, core } = qbx({ primary: 'liar' });

    expect(FrameworkBridge.getPlayer(1)!.setActiveJob('taxi')).toBe(false);
    expect(core.SetPlayerPrimaryJob).toHaveBeenCalledTimes(1);
    expect(player.PlayerData.job.name).toBe('police');
  });

  it('refuses a job the player does not hold without calling the framework', () => {
    const { core } = qbx();
    expect(FrameworkBridge.getPlayer(1)!.setActiveJob('lawyer')).toBe(false);
    expect(core.SetPlayerPrimaryJob).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
  });

  it('is already true for the active job, without a call', () => {
    const { core } = qbx();
    expect(FrameworkBridge.getPlayer(1)!.setActiveJob('police')).toBe(true);
    expect(core.SetPlayerPrimaryJob).not.toHaveBeenCalled();
  });

  it('refuses to switch on a build without SetPlayerPrimaryJob', () => {
    qbx({ exportsSetters: false });
    expect(FrameworkBridge.getPlayer(1)!.setActiveJob('taxi')).toBe(false);
  });

  it('clocks duty through the export and confirms it by re-reading onduty', () => {
    const { player, core } = qbx();
    const fp = FrameworkBridge.getPlayer(1)!;

    expect(fp.setDuty('police', false)).toBe(true);
    expect(core.SetJobDuty).toHaveBeenCalledWith(1, false);
    expect(player.Functions.SetJobDuty).not.toHaveBeenCalled();
    expect(fp.getJobs()[0].onDuty).toBe(false);
  });

  it('reports false when SetJobDuty claims success and onduty did not move', () => {
    qbx({ duty: 'liar' });
    expect(FrameworkBridge.getPlayer(1)!.setDuty('police', false)).toBe(false);
    // An ordinary boolean that disagrees is a refusal, not a contract change: no error.
    expect(errors()).toEqual([]);
  });

  it('refuses, and says why, when the re-read is not a boolean', () => {
    qbx({ duty: 'shapeless' });
    expect(FrameworkBridge.getPlayer(1)!.setDuty('police', false)).toBe(false);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain('PlayerData.job.onduty');
    expect(errors()[0]).toContain('a promise');
  });

  it('falls back to the player method on a build without the SetJobDuty export', () => {
    const { player } = qbx({ exportsSetters: false });
    expect(FrameworkBridge.getPlayer(1)!.setDuty('police', false)).toBe(true);
    expect(player.Functions.SetJobDuty).toHaveBeenCalledWith(false);
    expect(player.PlayerData.job.onduty).toBe(false);
  });

  it('refuses duty for a held job that is not the active one', () => {
    const { core } = qbx();
    expect(FrameworkBridge.getPlayer(1)!.setDuty('taxi', true)).toBe(false);
    expect(core.SetJobDuty).not.toHaveBeenCalled();
  });

  it('describes its support per build', () => {
    qbx();
    expect(qbxAdapter.jobSupport()).toEqual({
      multiJob: true,
      duty: true,
      via: 'qbx_core PlayerData.jobs + GetJob'
    });
    expect(FrameworkBridge.jobSupport()).toEqual(qbxAdapter.jobSupport());

    qbx({ getJob: false });
    expect(qbxAdapter.jobSupport()).toMatchObject({ multiJob: false, duty: true });
    expect(qbxAdapter.jobSupport().via).toContain('no GetJob');
  });
});

/* ── qb-core ───────────────────────────────────────────────────────────────────────────── */

/** A qb-core with one loaded player and the single job qb-core keeps. */
const qb = (opts: { duty?: 'honest' | 'liar' } = {}) => {
  const player: any = {
    PlayerData: {
      citizenid: 'CIT_QB',
      charinfo: {},
      job: {
        name: 'ambulance',
        label: 'EMS',
        isboss: true,
        onduty: false,
        payment: 120,
        grade: { name: 'Chief', level: 3 }
      }
    },
    Functions: {
      SetJobDuty: vi.fn((onDuty: boolean) => {
        if (opts.duty !== 'liar') player.PlayerData.job.onduty = onDuty;
        return true;
      })
    }
  };
  useResources({
    'qb-core': { GetCoreObject: () => ({ Functions: { GetPlayer: () => player } }) }
  });
  return { player };
};

describe('qb-core', () => {
  it('lists the one job qb-core keeps', () => {
    qb();
    expect(FrameworkBridge.getPlayer(2)!.getJobs()).toEqual([
      {
        name: 'ambulance',
        label: 'EMS',
        grade: 3,
        gradeLabel: 'Chief',
        salary: 120,
        onDuty: false,
        isBoss: true,
        active: true
      }
    ]);
  });

  it('can only "switch" to the job already active', () => {
    qb();
    const fp = FrameworkBridge.getPlayer(2)!;
    expect(fp.setActiveJob('ambulance')).toBe(true);
    expect(fp.setActiveJob('police')).toBe(false);
  });

  it('clocks duty through the player method and confirms by re-read', () => {
    const { player } = qb();
    const fp = FrameworkBridge.getPlayer(2)!;
    expect(fp.setDuty('ambulance', true)).toBe(true);
    expect(player.Functions.SetJobDuty).toHaveBeenCalledWith(true);
    expect(fp.getJobs()[0].onDuty).toBe(true);
  });

  it('reports false when the player method claims success and changes nothing', () => {
    qb({ duty: 'liar' });
    expect(FrameworkBridge.getPlayer(2)!.setDuty('ambulance', true)).toBe(false);
  });

  it('refuses duty for a job that is not the active one', () => {
    const { player } = qb();
    expect(FrameworkBridge.getPlayer(2)!.setDuty('police', true)).toBe(false);
    expect(player.Functions.SetJobDuty).not.toHaveBeenCalled();
  });

  it('says it reads one job and no multi-job resource', () => {
    qb();
    const support = qbAdapter.jobSupport();
    expect(support).toMatchObject({ multiJob: false, duty: true });
    expect(support.via).toContain('not read');
    expect(FrameworkBridge.jobSupport()).toEqual(support);
  });
});

/* ── es_extended ───────────────────────────────────────────────────────────────────────── */

const LICENSE = `license:${'c'.repeat(40)}`;

interface EsxOptions {
  /** Legacy 1.10+ carries `job.onDuty`; older builds have no such field. */
  duty?: boolean;
  /** Whether `setJob` honours its third argument. */
  setJob?: 'honest' | 'liar';
  /** Expose `getJob()` as well as the bare `job` table. */
  accessor?: boolean;
}

/** An `es_extended` with one xPlayer on the single job core ESX keeps. */
const esx = (opts: EsxOptions = {}) => {
  const job: any = {
    name: 'police',
    label: 'LSPD',
    grade: 1,
    grade_name: 'officer',
    grade_label: 'Officer',
    grade_salary: 80
  };
  if (opts.duty) job.onDuty = false;

  const xPlayer: any = {
    source: 3,
    identifier: LICENSE,
    job,
    setJob: vi.fn((name: string, grade: number, onDuty?: boolean) => {
      xPlayer.job = { ...xPlayer.job, name, grade };
      if (opts.setJob !== 'liar' && typeof onDuty === 'boolean') xPlayer.job.onDuty = onDuty;
    })
  };
  if (opts.accessor) xPlayer.getJob = () => xPlayer.job;

  useResources({
    es_extended: { getSharedObject: () => ({ GetPlayerFromId: () => xPlayer }) }
  });
  return { xPlayer };
};

describe('es_extended', () => {
  it('lists the one job, with duty null on a build that has no such field', () => {
    esx();
    expect(FrameworkBridge.getPlayer(3)!.getJobs()).toEqual([
      {
        name: 'police',
        label: 'LSPD',
        grade: 1,
        gradeLabel: 'Officer',
        salary: 80,
        onDuty: null,
        isBoss: false,
        active: true
      }
    ]);
  });

  it('reads duty when the core carries it, through the accessor when there is one', () => {
    esx({ duty: true, accessor: true });
    expect(FrameworkBridge.getPlayer(3)!.getJobs()[0].onDuty).toBe(false);
  });

  it('falls back from grade_label to grade_name to the number', () => {
    const { xPlayer } = esx();
    delete xPlayer.job.grade_label;
    expect(FrameworkBridge.getPlayer(3)!.getJobs()[0].gradeLabel).toBe('officer');
    delete xPlayer.job.grade_name;
    expect(FrameworkBridge.getPlayer(3)!.getJobs()[0].gradeLabel).toBe('1');
  });

  it('clocks duty through setJob and confirms by re-read', () => {
    const { xPlayer } = esx({ duty: true });
    const fp = FrameworkBridge.getPlayer(3)!;
    expect(fp.setDuty('police', true)).toBe(true);
    expect(xPlayer.setJob).toHaveBeenCalledWith('police', 1, true);
    expect(fp.getJobs()[0].onDuty).toBe(true);
  });

  it('reports false when setJob ignores its duty argument', () => {
    esx({ duty: true, setJob: 'liar' });
    expect(FrameworkBridge.getPlayer(3)!.setDuty('police', true)).toBe(false);
  });

  it('never calls setJob on a build with no duty notion', () => {
    const { xPlayer } = esx();
    expect(FrameworkBridge.getPlayer(3)!.setDuty('police', true)).toBe(false);
    expect(xPlayer.setJob).not.toHaveBeenCalled();
  });

  it('can only "switch" to the job already active', () => {
    esx();
    const fp = FrameworkBridge.getPlayer(3)!;
    expect(fp.setActiveJob('police')).toBe(true);
    expect(fp.setActiveJob('taxi')).toBe(false);
  });

  it('says duty is per player and esx_multijob is not read', () => {
    esx();
    const support = esxAdapter.jobSupport();
    expect(support).toMatchObject({ multiJob: false, duty: false });
    expect(support.via).toContain('onDuty');
    expect(support.via).toContain('not read');
    expect(FrameworkBridge.jobSupport()).toEqual(support);
  });
});

/* ── standalone, and nothing at all ────────────────────────────────────────────────────── */

describe('standalone', () => {
  beforeEach(() => {
    setConvar('1');
    useResources({});
    (globalThis as any).GetPlayerIdentifierByType = (_src: string, type: string) =>
      type === 'license' ? LICENSE : '';
  });

  it('answers [] and refuses both setters, quietly', () => {
    const fp = FrameworkBridge.getPlayer(4)!;
    expect(fp.getJobs()).toEqual([]);
    expect(fp.setActiveJob('police')).toBe(false);
    expect(fp.setDuty('police', true)).toBe(false);
    expect(warnings()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it('says there are no jobs', () => {
    expect(standaloneAdapter.jobSupport()).toMatchObject({ multiJob: false, duty: false });
    expect(FrameworkBridge.jobSupport()).toEqual(standaloneAdapter.jobSupport());
  });
});

describe('before any framework has answered', () => {
  it('says so rather than reporting the absence of jobs as a fact', () => {
    useResources({});
    expect(FrameworkBridge.jobSupport()).toEqual({
      multiJob: false,
      duty: false,
      via: 'no framework has answered yet'
    });
  });
});
