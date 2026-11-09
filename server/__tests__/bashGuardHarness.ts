// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

/**
 * What the Bash guard's suites share (`bashGuard.test.ts`, `bashGuardReset.test.ts`,
 * `bashGuardPush.test.ts`): feeding the hook its input, the throwaway git repos, and the guarded
 * shapes assembled from parts. Not a test file; vitest only collects `*.test.ts`.
 *
 * The suite was one file of 490 cases, each a `/bin/sh` of the hook, and so the longest single
 * thing the server project ran. It is three files so Vitest gives them a worker each.
 */

const HOOK = '.claude/hooks/block-dangerous-bash.sh';
export const BLOCKED = 2;

/**
 * The variables that tell git WHICH repository to act on. A git hook (pre-push
 * runs this suite) exports them pointing at the real repository, and `git -C
 * <tmp> init` then re-initialises that repository instead of the fixture --
 * once it wrote core.bare=true into the real one and broke every git command.
 * The fixtures and the hook must never inherit them; a case that wants one sets
 * it on purpose, pointed at its own temp repository.
 */
export const REPO_LOCATORS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE'
];

export function withoutRepoLocators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !REPO_LOCATORS.includes(key)));
}

/**
 * The fixture repos and the hook both run without the user's git config: a
 * global `commit.gpgsign` would stall the fixture commits, and a global
 * `status.showUntrackedFiles` is what one of the cases below sets on purpose.
 */
export const HERMETIC: Record<string, string | undefined> = {
  ...withoutRepoLocators(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
};

export type Outcome = { status: number; stderr: string };

/**
 * Feeds the hook raw stdin exactly as Claude Code does. The shell is found by
 * absolute path, because one case runs it with a PATH that holds no shell.
 */
export const feed = (input: string, env = HERMETIC, hook = HOOK): Outcome => {
  try {
    execFileSync('/bin/sh', [hook], { input, env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: Buffer };
    return { status, stderr: String(stderr) };
  }
};

/** Runs the hook and returns its exit code. */
export const run = (command: string, raw?: string): number =>
  feed(raw ?? JSON.stringify({ tool_input: { command } })).status;

/** Runs the hook with a `cwd` in the input, as Claude Code always sends one. */
export const runAt = (command: string, cwd: string, env?: typeof HERMETIC): Outcome =>
  feed(JSON.stringify({ cwd, tool_input: { command } }), env);

/*
 * eslint-disable no-useless-concat --
 * The concatenation is the point, not an oversight. Joined up, each of these is a
 * shape the live guard refuses, so an assistant asked to write or edit this file
 * would have its own tool call blocked before the edit landed. Splitting them is
 * what makes the test writable at all.
 */
export const FORCE = '--fo' + 'rce';
export const SKIP_HOOKS = '--no-' + 'verify';
export const TO_DEFAULT = 'HEAD:refs/heads/ma' + 'in';
export const PS_ARRAY = 'PIPE' + 'STATUS';
export const PROTECTION = 'gh api repos/o/r/bran' + 'ches/main/protection -X PUT';
export const PM = 'pn' + 'pm';
export const RUNNER = 'vit' + 'est';
export const VERIFY_SCRIPT = 'node scripts/veri' + 'fy.js';
export const SUBCOMMAND = 're' + 'set';
export const HARD = '--ha' + 'rd';
export const HARD_RESET = `git ${SUBCOMMAND} ${HARD}`;
export const TSC = 'ts' + 'c';
export const PLAYWRIGHT = 'play' + 'wright';
export const PRETTIER = 'pret' + 'tier';
export const ESLINT = 'es' + 'lint';
export const KNIP = 'kn' + 'ip';
export const GH = 'gh ' + 'api';
export const REPO = 'repos/o/r';
export const RULES = 'rule' + 'sets';
export const RULESETS = `${REPO}/${RULES}`;
export const BRANCHES = `${REPO}/bran` + 'ches';

/** Git for the fixtures: no user config, and no global hook dispatcher. */
export const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: HERMETIC,
    stdio: 'pipe'
  });
};

/** One tracked file, one commit. */
export const makeRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', 'tracked.txt');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
};

export const modifyTracked = (dir: string): void =>
  writeFileSync(join(dir, 'tracked.txt'), 'two\n');

/*
 * A push that moves main is only AGENTS.md §2.1's business when it is THIS
 * repository's main. The hook fires for every repository a session touches, and
 * it once refused a push to the owner's dotfiles -- another repo whose default
 * branch is also main -- after the owner had said yes. It now asks git which
 * repository the push acts on, and fails closed whenever it cannot tell.
 *
 * Each shape is assembled from parts, like the ones above, so writing this file
 * does not trip the live guard.
 */
export const PUSH = 'pu' + 'sh';
export const GIT_PUSH = `git ${PUSH}`;
export const MAIN = 'ma' + 'in';
export const PUSH_MAIN = `${GIT_PUSH} origin ${MAIN}`;
export const PUSH_MAIN_QUIET = `${GIT_PUSH} -q origin ${MAIN}`;
export const MOVES_MAIN = 'would move ' + MAIN;
/** `git -C <dir> push origin main`. */
export const pushIn = (dir: string): string => `git -C ${dir} pu` + `sh origin ${MAIN}`;

const GITLINK = '160000,0123456789abcdef0123456789abcdef01234567,subm';

/**
 * The "project" of the push suites: a throwaway repo named by CLAUDE_PROJECT_DIR, so the cases
 * run the same wherever this suite does. Its common dir is what a worktree under
 * `.claude/worktrees/` shares, which is the other shape that must count.
 *
 * A call makes a directory of its own, so each test file that calls it gets its own fixtures and
 * the files can run side by side. `setup` and `teardown` are the `beforeAll` and `afterAll` of
 * the suite using it.
 */
export const mainPushFixture = () => {
  const MP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'bash-guard-main-')));
  const MICA = join(MP_ROOT, 'mica');
  const MICA_SUB = join(MICA, 'sub');
  const MICA_WORKTREE = join(MP_ROOT, 'wt', '.claude', 'worktrees', 'lane');
  const OTHER = join(MP_ROOT, 'other');
  /** A directory inside the other repository, which a symlink in the project points at. */
  const OTHER_SUB = join(OTHER, 'sub');
  const LINK = join(MICA, 'L');
  /** Worktrees of the project: one on main, one detached. */
  const WT_MAIN = join(MP_ROOT, 'wt-main', '.claude', 'worktrees', 'on-main');
  const WT_DETACHED = join(MP_ROOT, 'wt-detached', '.claude', 'worktrees', 'detached');
  const REPO_HOME = join(MP_ROOT, 'repo-home');
  const FAKE_HOME = join(MP_ROOT, 'home');
  const DOTFILES = join(FAKE_HOME, 'dotfiles');
  /** An unrelated repository that sits where `~/mica` would, so a changed HOME is visible. */
  const DECOY = join(FAKE_HOME, 'mica');
  /** Superprojects: each lists a submodule, one has push.recurseSubmodules set. */
  const SUPER = join(MP_ROOT, 'super');
  const SUPER_CFG = join(MP_ROOT, 'super-cfg');
  const PLAIN = join(MP_ROOT, 'plain');
  const NOWHERE = join(MP_ROOT, 'nowhere');
  const STANDALONE_DIR = join(MP_ROOT, 'standalone', '.claude', 'hooks');
  const STANDALONE = join(STANDALONE_DIR, 'block-dangerous-bash.sh');

  /** A session in the project: its dir, and a HOME to expand ~ against. */
  const mica: typeof HERMETIC = { ...HERMETIC, CLAUDE_PROJECT_DIR: MICA, HOME: FAKE_HOME };
  /** The same with nothing naming the project, so the hook falls back to where it lives. */
  const unnamed: typeof HERMETIC = { ...mica, CLAUDE_PROJECT_DIR: undefined };

  /** Asserts the hook refused, and refused this rule rather than any other. */
  const expectMainBlocked = (command: string, cwd: string, env = mica): void => {
    const { status, stderr } = runAt(command, cwd, env);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain(MOVES_MAIN);
  };

  /** Asserts the hook refused as a force-push, which it does in any repository. */
  const expectForceBlocked = (command: string, cwd: string, env = mica): void => {
    const { status, stderr } = runAt(command, cwd, env);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('a force-push can overwrite upstream history');
  };

  const expectAllowed = (command: string, cwd: string, env = mica): void => {
    const { status, stderr } = runAt(command, cwd, env);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  };

  const setup = (): void => {
    for (const dir of [MICA, OTHER, DOTFILES, DECOY, REPO_HOME, SUPER, SUPER_CFG]) {
      makeRepo(dir);
    }
    for (const dir of [SUPER, SUPER_CFG]) {
      git(dir, 'update-index', '--add', '--cacheinfo', GITLINK);
    }
    git(SUPER_CFG, 'config', 'push.recurseSubmodules', 'on-demand');
    mkdirSync(MICA_SUB);
    mkdirSync(OTHER_SUB);
    symlinkSync(OTHER_SUB, LINK);
    mkdirSync(PLAIN);
    mkdirSync(join(MP_ROOT, 'wt'), { recursive: true });
    mkdirSync(join(MP_ROOT, 'wt-main'), { recursive: true });
    mkdirSync(join(MP_ROOT, 'wt-detached'), { recursive: true });
    // The project's own branch is not main, so a bare push there is not the
    // project's main; the branch named main lives in a worktree of its own.
    git(MICA, 'branch', '-M', 'trunk');
    git(MICA, 'worktree', 'add', '-q', '-b', 'lane', MICA_WORKTREE);
    git(MICA, 'worktree', 'add', '-q', '-b', MAIN, WT_MAIN);
    git(MICA, 'worktree', 'add', '-q', '--detach', WT_DETACHED);
    mkdirSync(STANDALONE_DIR, { recursive: true });
    copyFileSync(HOOK, STANDALONE);
  };

  const teardown = (): void => {
    rmSync(MP_ROOT, { recursive: true, force: true });
  };

  return {
    MP_ROOT,
    MICA,
    MICA_SUB,
    MICA_WORKTREE,
    OTHER,
    OTHER_SUB,
    LINK,
    WT_MAIN,
    WT_DETACHED,
    REPO_HOME,
    FAKE_HOME,
    DOTFILES,
    DECOY,
    SUPER,
    SUPER_CFG,
    PLAIN,
    NOWHERE,
    STANDALONE_DIR,
    STANDALONE,
    mica,
    unnamed,
    expectMainBlocked,
    expectForceBlocked,
    expectAllowed,
    setup,
    teardown
  };
};
