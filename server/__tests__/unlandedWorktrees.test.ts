// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HERMETIC } from './bashGuardHarness';

/**
 * The SessionStart hook that names lane worktrees holding work not on dev
 * (`.claude/hooks/unlanded-worktrees.sh`).
 *
 * It exists because a lead session died mid-integration and three finished lane commits sat in
 * `.claude/worktrees/agent-*` with nothing to say so. A hook that cannot run reads as "nothing
 * stranded", so the tests below cover its failure lines as hard as its findings, and every
 * "prints nothing" case has a sibling in the same repo that is reported: a filter that reports
 * nothing at all would pass the first alone.
 */

const ROOT = resolve(__dirname, '../..');
const HOOK = join(ROOT, '.claude/hooks/unlanded-worktrees.sh');

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...IDENT, ...args], {
    env: HERMETIC,
    stdio: 'pipe'
  });
};

/** Runs the hook; `dir` undefined leaves CLAUDE_PROJECT_DIR unset. Returns stdout and the status. */
const hook = (dir: string | undefined): { out: string; status: number } => {
  const env = { ...HERMETIC };
  delete env.CLAUDE_PROJECT_DIR;
  if (dir !== undefined) env.CLAUDE_PROJECT_DIR = dir;
  try {
    const out = execFileSync('/bin/sh', [HOOK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { out: String(out), status: 0 };
  } catch (error) {
    const { status, stdout } = error as { status: number; stdout: Buffer };
    return { out: String(stdout), status };
  }
};

const commit = (dir: string, file: string): void => {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', file);
};

let scratch = '';
let repoCount = 0;

/** A repo whose only branch is `dev`, with one commit. */
const makeRepo = (): string => {
  const dir = join(scratch, `repo${repoCount++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'dev');
  commit(dir, 'tracked.txt');
  return dir;
};

const lane = (repo: string, name: string, branch: string | null = name): string => {
  const path = join(repo, '.claude/worktrees', name);
  if (branch) git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'refs/heads/dev');
  else git(repo, 'worktree', 'add', '-q', '--detach', path, 'refs/heads/dev');
  return path;
};

const dirty = (path: string, ...files: string[]): void => {
  for (const file of files) writeFileSync(join(path, file), 'x\n');
};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'unlanded-')));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('unlanded-worktrees hook', () => {
  it('names a worktree with commits not on dev, with the count', () => {
    const repo = makeRepo();
    const path = lane(repo, 'agent-one');
    commit(path, 'a.txt');
    commit(path, 'b.txt');

    const { out, status } = hook(repo);
    expect(status).toBe(0);
    expect(out).toContain('.claude/worktrees/agent-one');
    expect(out).toContain('agent-one  2 commits not on dev, 0 uncommitted paths');
    expect(out).toContain('hold work not on dev');
    expect(out).toContain('lead-protocol');
  });

  it('names a worktree that is only dirty, counting tracked and untracked paths', () => {
    const repo = makeRepo();
    const path = lane(repo, 'agent-dirty', null);
    dirty(path, 'u1.txt', 'u2.txt');
    writeFileSync(join(path, 'tracked.txt'), 'changed\n');

    const { out } = hook(repo);
    expect(out).toContain(
      '.claude/worktrees/agent-dirty  detached  0 commits not on dev, 3 uncommitted'
    );
  });

  it('prints nothing for a worktree equal to dev while a sibling is reported', () => {
    const repo = makeRepo();
    lane(repo, 'agent-clean');
    const stranded = lane(repo, 'agent-stranded');
    commit(stranded, 'c.txt');

    const { out } = hook(repo);
    expect(out).toContain('agent-stranded');
    expect(out).not.toContain('agent-clean');
  });

  it('prints nothing at all when every worktree is equal to dev', () => {
    const repo = makeRepo();
    lane(repo, 'agent-clean');
    expect(hook(repo)).toEqual({ out: '', status: 0 });
  });

  it('ignores a worktree outside .claude/worktrees/ even when it holds work', () => {
    const repo = makeRepo();
    const elsewhere = join(scratch, `elsewhere${repoCount}`);
    git(repo, 'worktree', 'add', '-q', '-b', 'outside', elsewhere, 'refs/heads/dev');
    commit(elsewhere, 'o.txt');
    const stranded = lane(repo, 'agent-stranded');
    commit(stranded, 'c.txt');

    const { out } = hook(repo);
    expect(out).toContain('agent-stranded');
    expect(out).not.toContain('outside');
    expect(out).not.toContain('elsewhere');
  });

  it('reports a prunable worktree whose directory is gone', () => {
    const repo = makeRepo();
    const path = lane(repo, 'agent-gone');
    commit(path, 'g.txt');
    rmSync(path, { recursive: true, force: true });

    const { out } = hook(repo);
    expect(out).toContain('agent-gone');
    expect(out).toContain('1 commits not on dev');
    expect(out).toContain('prunable');
  });

  it('is not fooled by a tracked dev/ directory making the bare name ambiguous', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'dev'));
    commit(repo, 'dev/file.txt');
    const stranded = lane(repo, 'agent-stranded');
    commit(stranded, 'c.txt');

    const { out } = hook(repo);
    expect(out).toContain('agent-stranded  1 commits not on dev');
  });

  describe('when it cannot check, it says so and still exits 0', () => {
    it('refs/heads/dev is missing', () => {
      const repo = makeRepo();
      git(repo, 'branch', '-m', 'dev', 'main');
      const { out, status } = hook(repo);
      expect(status).toBe(0);
      expect(out).toMatch(/^unlanded-worktrees: could not check: .*refs\/heads\/dev/);
    });

    it('the directory is not a git repository', () => {
      const dir = join(scratch, 'not-a-repo');
      mkdirSync(dir);
      const { out, status } = hook(dir);
      expect(status).toBe(0);
      expect(out).toMatch(/^unlanded-worktrees: could not check: .*not a git repository/);
    });

    it('CLAUDE_PROJECT_DIR is unset', () => {
      const { out, status } = hook(undefined);
      expect(status).toBe(0);
      expect(out).toMatch(/^unlanded-worktrees: could not check: .*CLAUDE_PROJECT_DIR/);
    });

    it('CLAUDE_PROJECT_DIR is not a directory', () => {
      const { out, status } = hook(join(scratch, 'missing'));
      expect(status).toBe(0);
      expect(out).toMatch(/^unlanded-worktrees: could not check: /);
    });
  });
});

describe('.claude/settings.json hook commands', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')) as {
    hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  };
  const commands = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((h) => ({ event, command: h.command })))
  );

  it('registers hooks to check', () => {
    // An emptied hooks block would pass the loop below for free.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((c) => c.event)).toContain('SessionStart');
  });

  it.each(commands)('$event: $command is an existing executable file', ({ command }) => {
    const path = command.replaceAll('$CLAUDE_PROJECT_DIR', ROOT);
    expect(existsSync(path), `${command} resolves to ${path}, which does not exist`).toBe(true);
    expect(() => accessSync(path, constants.X_OK), `${path} is not executable`).not.toThrow();
  });
});
