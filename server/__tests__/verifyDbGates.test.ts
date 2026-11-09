// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { DB_GATES, databaseAvailable, planDbGates } from '../../scripts/lib/db-gates.js';

/**
 * MICA-465: `pnpm verify` runs the real-MariaDB gates when a database can be had, and says
 * NOT RUN -- never a tick -- when it cannot. The plan is pure, so it is decided here; the
 * last cases hold the wiring in `verify.js` and CI, since a correct plan proves nothing if
 * the script stops consulting it.
 */
const yes = () => ({ ok: true as const, via: 'docker' });
const no = () => ({ ok: false as const, reason: 'the docker daemon is not reachable' });

describe('planDbGates', () => {
  it('runs schema and endpoints when a database is available, migrations stays opt-in', () => {
    const plan = planDbGates({ probe: yes });
    expect(plan.run.map((g) => g.name)).toEqual(['schema', 'endpoints']);
    expect(plan.notRun.map((g) => g.name)).toEqual(['migrations']);
    expect(plan.notRun[0].reason).toContain('--migrations');
  });

  it('--migrations adds the migration replay last', () => {
    const plan = planDbGates({ probe: yes, migrations: true });
    expect(plan.run.map((g) => g.name)).toEqual(['schema', 'endpoints', 'migrations']);
    expect(plan.notRun).toEqual([]);
  });

  it('with no database, every gate is NOT RUN with a reason and none is run', () => {
    const plan = planDbGates({ probe: no, migrations: true });
    expect(plan.run).toEqual([]);
    expect(plan.notRun.map((g) => g.name)).toEqual(DB_GATES.map((g) => g.name));
    for (const g of plan.notRun) expect(g.reason).toMatch(/not reachable.*nothing was tested/);
  });

  it('--no-db lists them as skipped and consults nothing', () => {
    const plan = planDbGates({
      noDb: true,
      probe: () => {
        throw new Error('probed');
      }
    });
    expect(plan.run).toEqual([]);
    expect(plan.notRun).toEqual([]);
    expect(plan.skipped).toEqual(['schema', 'endpoints', 'migrations']);
  });
});

describe('databaseAvailable', () => {
  const spawn = (status: number | null, error?: { code: string }) => () => ({ status, error });

  it('is available when docker info succeeds', () => {
    expect(databaseAvailable({}, spawn(0)).ok).toBe(true);
  });

  it('is unavailable, with a reason, when the daemon answers an error', () => {
    const r = databaseAvailable({}, spawn(1));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('daemon is not reachable') });
  });

  it('is unavailable when docker is not installed', () => {
    const r = databaseAvailable({}, spawn(null, { code: 'ENOENT' }));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('ENOENT') });
  });

  it('counts a named database as available without asking docker', () => {
    const boom = () => {
      throw new Error('asked docker');
    };
    expect(databaseAvailable({ MICA_DB_HOST: 'db' }, boom).ok).toBe(true);
  });
});

describe('wiring', () => {
  const verify = readFileSync('scripts/verify.js', 'utf8');

  it('verify.js plans from planDbGates, runs its gates and prints its NOT RUN rows', () => {
    expect(verify).toContain("from './lib/db-gates.js'");
    expect(verify).toContain('for (const g of dbPlan.run)');
    expect(verify).toContain('NOT RUN');
    expect(verify).toContain('notRun });');
  });

  it('every DB gate is a named GATES entry and a package.json script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const g of DB_GATES) {
      expect(verify).toContain(`'${g.name}'`);
      expect(pkg.scripts[g.script]).toBeTruthy();
    }
  });

  it("CI's verify job passes --no-db, so the schema and endpoints jobs are not doubled", () => {
    const wf = readFileSync('.github/workflows/build-test.yml', 'utf8');
    expect(wf).toContain('pnpm verify --quick --no-container --no-db');
  });
});
