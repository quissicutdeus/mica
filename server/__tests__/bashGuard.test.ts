// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Bash guard has to actually fire.
 *
 * `.claude/hooks/block-dangerous-bash.sh` is what AGENTS.md §2.1 points at when
 * it says a force-push, a push that moves the default branch, and the flag that
 * skips hooks are enforced rather than merely written down. It parsed its input
 * with `jq`, which was not installed on these machines, so the command was the
 * empty string on every call, no case matched, and it exited 0 -- allowing every
 * shape it names, for its entire existence, while reading as a working guard.
 *
 * That is the failure this repo warns about most often, so the guard now gets
 * the treatment every other gate here gets: a suite that drives it with inputs
 * it must refuse and inputs it must not, and that goes red if it ever falls
 * silent again. A guard nobody has watched block something is a guard nobody
 * knows works.
 *
 * The hard-reset rule is the one shape that depends on the filesystem, not just
 * the text: it blocks only over a dirty tree outside `.claude/worktrees/`. Its
 * cases therefore run against real throwaway git repos, with the hook's `cwd`
 * field in the input exactly as Claude Code sends it.
 *
 * Every guarded shape below is assembled from parts on purpose, identifiers
 * included. Spelled out, it would be caught by the live guard the moment an
 * assistant tried to write or edit this file -- which is itself a small proof
 * that the thing works.
 */

const HOOK = '.claude/hooks/block-dangerous-bash.sh';
const BLOCKED = 2;

/**
 * The fixture repos and the hook both run without the user's git config: a
 * global `commit.gpgsign` would stall the fixture commits, and a global
 * `status.showUntrackedFiles` is what one of the cases below sets on purpose.
 */
const HERMETIC: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
};

type Outcome = { status: number; stderr: string };

/**
 * Feeds the hook raw stdin exactly as Claude Code does. The shell is found by
 * absolute path, because one case runs it with a PATH that holds no shell.
 */
const feed = (input: string, env = HERMETIC): Outcome => {
  try {
    execFileSync('/bin/sh', [HOOK], { input, env, stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: Buffer };
    return { status, stderr: String(stderr) };
  }
};

/** Runs the hook and returns its exit code. */
const run = (command: string, raw?: string): number =>
  feed(raw ?? JSON.stringify({ tool_input: { command } })).status;

/** Runs the hook with a `cwd` in the input, as Claude Code always sends one. */
const runAt = (command: string, cwd: string, env?: typeof HERMETIC): Outcome =>
  feed(JSON.stringify({ cwd, tool_input: { command } }), env);

/*
 * eslint-disable no-useless-concat --
 * The concatenation is the point, not an oversight. Joined up, each of these is a
 * shape the live guard refuses, so an assistant asked to write or edit this file
 * would have its own tool call blocked before the edit landed. Splitting them is
 * what makes the test writable at all.
 */
const FORCE = '--fo' + 'rce';
const SKIP_HOOKS = '--no-' + 'verify';
const TO_DEFAULT = 'HEAD:refs/heads/ma' + 'in';
const PS_ARRAY = 'PIPE' + 'STATUS';
const PROTECTION = 'gh api repos/o/r/bran' + 'ches/main/protection -X PUT';
const PM = 'pn' + 'pm';
const RUNNER = 'vit' + 'est';
const VERIFY_SCRIPT = 'node scripts/veri' + 'fy.js';
const SUBCOMMAND = 're' + 'set';
const HARD = '--ha' + 'rd';
const HARD_RESET = `git ${SUBCOMMAND} ${HARD}`;
const TSC = 'ts' + 'c';
const PLAYWRIGHT = 'play' + 'wright';
const PRETTIER = 'pret' + 'tier';
const ESLINT = 'es' + 'lint';
const KNIP = 'kn' + 'ip';

describe('the Bash guard blocks what AGENTS.md §2.1 says it blocks', () => {
  it.each([
    ['a force-push', `git push ${FORCE} origin dev`],
    ['a push that moves the default branch', `git push origin ${TO_DEFAULT}`],
    ['bypassing a hook', `git commit ${SKIP_HOOKS} -m x`],
    ['changing branch protection', PROTECTION]
  ])('blocks %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });
});

describe('the Bash guard blocks a gate whose exit code would be lost', () => {
  it.each([
    ['a gate piped into tail', `${PM} verify 2>&1 | tail -16`],
    ['a gate piped into grep', `${PM} test:unit 2>&1 | grep -E "Test Files"`],
    ['a checker piped anywhere', `${PM} exec ${RUNNER} run x.test.ts | tail -3`],
    ['the array that is empty in zsh', `${PM} build; echo \${${PS_ARRAY}[0]}`],
    ['a script gate piped into tail', `${VERIFY_SCRIPT} | tail -5`]
  ])('blocks %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });
});

describe('the Bash guard leaves ordinary work alone', () => {
  it.each([
    ['an ordinary push', 'git push origin dev'],
    ['a gate with its output redirected', `${PM} verify > /tmp/v.log 2>&1; rc=$?`],
    ['a gate with no pipe at all', `${PM} verify --quick`],
    ['|| after a gate, which keeps its status', `${PM} verify || echo failed`],
    ['piping something that is not a gate', 'git log --oneline -3 | head -2'],
    ['listing files', 'ls sdk/ | head -20'],

    // Both of these are regressions, not hypotheticals: the first two attempts
    // at the pipe rule got one each, and each failure pointed the opposite way.
    //
    // A rule that tested "is there a gate?" and "is there a pipe?" as separate
    // greps matched any script that merely named a gate and piped something
    // unrelated -- ordinary work, refused. And the fix for that excluded `&`
    // from the separator class, which stopped `2>&1` matching and quietly let
    // the single most common broken shape straight through.
    [
      'a script that names a gate and pipes something else',
      [`# runs ${PM} verify later`, 'ls | wc -l'].join('\n')
    ],
    ['&& after a gate, which keeps its status', `${PM} verify && ls sdk/ | head -3`]
  ])('allows %s', (_label, command) => {
    expect(run(command)).toBe(0);
  });
});

/*
 * The pipe rule asks whether the gate is the command being run, not whether its
 * name appears somewhere in the command. Both halves are pinned: it cried wolf
 * on `pgrep -fa <checker> | head` and friends, and a guard that does that gets
 * switched off -- but every way of actually running a gate must stay refused,
 * because loosening the rule to quiet the false alarm would reopen the real
 * hole it exists for.
 */
describe('the Bash guard refuses a gate in command position, however it is reached', () => {
  it.each([
    ['a launcher', `${PM} exec ${RUNNER} run x.test.ts | tail`],
    ['npx', `npx ${TSC} --noEmit | tail`],
    ['pnpm dlx', `${PM} dlx ${PRETTIER} --check . | tail`],
    ['pnpm running the binary directly', `${PM} ${RUNNER} run | tail`],
    ['after a cd', `cd web && ${RUNNER} run | tail`],
    ['after an assignment', `FOO=1 ${RUNNER} run | tail`],
    ['after an assignment with a quoted value', `FOO="a b" ${RUNNER} run | tail`],
    ['after two assignments', `A=1 B=2 ${TSC} -p . | tail`],
    ['inside a subshell', `(${RUNNER} run | tail)`],
    ['inside a command substitution', `echo $(${PLAYWRIGHT} test | tail)`],
    ['inside a backtick substitution', `echo \`${TSC} | tail\``],
    ['inside a brace group', `{ ${TSC} -p .; ${ESLINT} . | tail; }`],
    ['through a package filter', `${PM} --filter web exec ${RUNNER} run | tail`],
    ['through a short package filter', `${PM} -F web exec ${RUNNER} run | tail`],
    ['through a directory option', `${PM} -C web exec ${RUNNER} run | tail`],
    ['through a long directory option', `${PM} --dir web exec ${RUNNER} run | tail`],
    ['through a relative path to the binary', `./node_modules/.bin/${TSC} | tail`],
    ['through a workspace path to the binary', `web/node_modules/.bin/${RUNNER} run | tail`],
    ['through time', `time ${TSC} -p . | tail`],
    ['through env', `env FOO=1 ${RUNNER} run | tail`],
    ['through nice and its option', `nice -n 5 ${TSC} | tail`],
    ['through exec', `exec ${RUNNER} run | tail`],
    ['through xargs', `ls | xargs ${PRETTIER} --check | tail`],
    ['through eval', `eval "${RUNNER} run | tail"`],
    ['with stderr merged into the pipe', `${RUNNER} run 2>&1 | tail`],
    ['after a semicolon', `true; ${TSC} | tail`],
    ['after ||', `false || ${TSC} | tail`],
    ['as a later stage of a pipeline', `cat x.ts | ${PRETTIER} --stdin-filepath x.ts | head`],
    ['as an if condition', `if ${RUNNER} run | tail; then :; fi`],
    ['in a loop body', `for f in a b; do ${RUNNER} run $f | tail; done`],
    ['on a later line of a script', ['set -e', `${TSC} | tail`].join('\n')],
    ['inside sh -c', `sh -c '${PM} test | tail'`],
    ['inside bash -lc', `bash -lc "${RUNNER} run | tail"`]
  ])('blocks %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });

  it.each([
    ['pnpm behind a package filter', `${PM} --filter web test | tail`],
    ['pnpm run', `${PM} run test:unit | tail`],
    ['pnpm -C and run', `${PM} -C web run lint | tail`],
    ['pnpm with -r', `${PM} -r test | tail`],
    ['npm test', 'npm test | tail'],
    ['npm run', 'npm run build | tail'],
    ['npm with a workspace', 'npm -w web run test | tail'],
    ['yarn test', 'yarn test | tail'],
    ['yarn in a workspace', 'yarn workspace web test | tail'],
    ['a gate after a cd', `cd web && ${PM} test:unit | tail`],
    ['a gate under time', `time ${PM} verify | tail`],
    ['a gate after an assignment', `CI=1 ${PM} verify | tail`],
    ['a script gate after a cd', `cd .. && ${VERIFY_SCRIPT} | tail`],
    ['a script gate with ./', `${VERIFY_SCRIPT.replace('scripts/', './scripts/')} | tail`]
  ])('blocks the pnpm family too: %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });

  it('still lets || through after a gate, which keeps its status', () => {
    expect(run(`${RUNNER} run || echo failed`)).toBe(0);
  });

  it('still lets && through after a gate, which keeps its status', () => {
    expect(run(`${RUNNER} run && ls | head -3`)).toBe(0);
  });
});

describe('the Bash guard leaves a gate named in argument position alone', () => {
  it.each([
    ['looking for a process by name', `pgrep -fa ${PLAYWRIGHT} | head`],
    ['filtering a process list for the name', `ps aux | grep ${RUNNER} | wc -l`],
    ['searching a tree for the name', `grep -rn ${TSC} docs | head`],
    ['searching the log for the name', `git log --grep=${PRETTIER} | head`],
    ['echoing the name', `echo ${ESLINT} | cat`],
    ['reading a config file named after it', `cat ${KNIP}.json | head`],
    ['filtering a listing for the name', `ls node_modules/.bin | grep ${TSC}`],
    ['xargs handing the name to grep', `ls | xargs grep -l ${TSC} | head`],
    ['asking pnpm why it is installed', `${PM} why ${RUNNER} | head`],
    ['listing what pnpm installed', `${PM} list | grep ${PRETTIER}`],
    ['searching for the name of a pnpm gate', `grep -rn "${PM} test" docs | head`],
    ['searching the log for a pnpm gate', `git log --grep="${PM} verify" | head`],
    ['a comment that shows a piped gate', [`# ${RUNNER} run | tail is wrong`, 'ls'].join('\n')]
  ])('allows %s', (_label, command) => {
    expect(run(command)).toBe(0);
  });
});

describe('the Bash guard fails closed when its own pipe check cannot run', () => {
  const BIN = mkdtempSync(join(tmpdir(), 'bash-guard-bin-'));

  beforeAll(() => {
    // node, and nothing else: no grep, so the pipe check's grep cannot start.
    symlinkSync(process.execPath, join(BIN, 'node'));
  });

  afterAll(() => {
    rmSync(BIN, { recursive: true, force: true });
  });

  it('refuses an ordinary command rather than letting it through unchecked', () => {
    const { status, stderr } = feed(JSON.stringify({ tool_input: { command: 'ls' } }), {
      ...HERMETIC,
      PATH: BIN
    });
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('pipe check');
  });
});

describe('the Bash guard fails closed when it cannot read its input', () => {
  it('blocks input that is not JSON, rather than waving it through', () => {
    expect(run('', 'this is not json')).toBe(BLOCKED);
  });

  it('allows a well-formed payload that simply carries no command', () => {
    expect(run('', JSON.stringify({ tool_input: {} }))).toBe(0);
  });
});

describe('the Bash guard tells a blocked pipe where to put its log', () => {
  const { status, stderr } = feed(
    JSON.stringify({ tool_input: { command: `${PM} verify 2>&1 | tail -16` } })
  );

  it('suggests a per-lane log in the scratchpad, never a shared one in /tmp', () => {
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('<scratchpad>/<callsign>-<gate>.log');
    expect(stderr).not.toContain('/tmp/gate.log');
  });

  it('keeps the advice about reading the real exit code', () => {
    expect(stderr).toContain('rc=$?');
    expect(stderr).toContain('${pipestatus[1]}');
  });
});

/*
 * The hard reset. Everything below runs against real git repos, because the
 * rule's whole point is what `git status` says about the tree: a text-only
 * stub would pass whether or not the guard ever asked git anything.
 */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'bash-guard-')));
const CLEAN = join(ROOT, 'clean');
const DIRTY_TRACKED = join(ROOT, 'dirty-tracked');
const DIRTY_UNTRACKED = join(ROOT, 'dirty-untracked');
const DIRTY_STAGED = join(ROOT, 'dirty-staged');
const WORKTREE = join(ROOT, '.claude', 'worktrees', 'dirty-lane');
const SUBDIR = join(DIRTY_TRACKED, 'sub');
const MISSING = join(ROOT, 'does-not-exist');

/** Git for the fixtures: no user config, and no global hook dispatcher. */
const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: HERMETIC,
    stdio: 'pipe'
  });
};

/** One tracked file, one commit. */
const makeRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', 'tracked.txt');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
};

const modifyTracked = (dir: string): void => writeFileSync(join(dir, 'tracked.txt'), 'two\n');

/** Asserts the hook refused, and refused for the reset rule rather than any other. */
const expectResetBlocked = (command: string, cwd: string, env?: typeof HERMETIC): void => {
  const { status, stderr } = runAt(command, cwd, env);
  expect(status).toBe(BLOCKED);
  expect(stderr).toContain('hard reset');
};

describe('the Bash guard and a hard reset over uncommitted work', () => {
  beforeAll(() => {
    for (const dir of [CLEAN, DIRTY_TRACKED, DIRTY_UNTRACKED, DIRTY_STAGED, WORKTREE]) {
      makeRepo(dir);
    }
    modifyTracked(DIRTY_TRACKED);
    mkdirSync(SUBDIR);
    writeFileSync(join(DIRTY_UNTRACKED, 'new.txt'), 'new\n');
    writeFileSync(join(DIRTY_STAGED, 'staged.txt'), 'staged\n');
    git(DIRTY_STAGED, 'add', 'staged.txt');
    modifyTracked(WORKTREE);
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  describe('blocks it when the tree it acts on has uncommitted changes', () => {
    it.each([
      ['a modified tracked file', DIRTY_TRACKED],
      ['an untracked file and nothing else', DIRTY_UNTRACKED],
      ['a staged new file and nothing else', DIRTY_STAGED],
      ['a subdirectory of a dirty repo, found through its toplevel', SUBDIR]
    ])('with %s', (_label, cwd) => {
      expectResetBlocked(HARD_RESET, cwd);
    });

    it('sees an untracked file even when the user config hides untracked files', () => {
      // The check passes --untracked-files=normal; without it, a
      // status.showUntrackedFiles=no in the user's config would blind the guard.
      const config = join(ROOT, 'hide-untracked.gitconfig');
      writeFileSync(config, '[status]\n\tshowUntrackedFiles = no\n');
      expectResetBlocked(HARD_RESET, DIRTY_UNTRACKED, { ...HERMETIC, GIT_CONFIG_GLOBAL: config });
    });

    it.each([
      ['the commit before the flag', `git ${SUBCOMMAND} HEAD ${HARD}`],
      ['the flag after another flag', `git ${SUBCOMMAND} -q ${HARD}`],
      ['the flag before a commit', `${HARD_RESET} HEAD`],
      [
        'a git option in front of the subcommand',
        `git -c core.quotepath=off ${SUBCOMMAND} ${HARD}`
      ],
      ['the --no-pager option', `git --no-pager ${SUBCOMMAND} ${HARD}`],
      ['an absolute path to git', `/usr/bin/git ${SUBCOMMAND} ${HARD}`],
      ['an abbreviation git accepts as hard', `git ${SUBCOMMAND} --har`],
      ['the shortest abbreviation git accepts as hard', `git ${SUBCOMMAND} --h`],
      ['a command chained after another', `true && ${HARD_RESET}`],
      ['a command after a semicolon', `echo go; ${HARD_RESET}`],
      ['a command inside a subshell', `(${HARD_RESET})`],
      ['a command substitution', `echo $(${HARD_RESET})`],
      ['a backtick substitution', `echo \`${HARD_RESET}\``],
      ['a brace group', `{ ${HARD_RESET}; }`],
      ['a command inside sh -c', `sh -c '${HARD_RESET}'`],
      ['a command run through xargs', `echo HEAD | xargs git ${SUBCOMMAND} ${HARD}`],
      ['a line continuation between the words', `git ${SUBCOMMAND} \\\n  ${HARD}`]
    ])('whatever the spelling: %s', (_label, command) => {
      expectResetBlocked(command, DIRTY_TRACKED);
    });

    it('follows -C to the tree it names, not the working directory', () => {
      expectResetBlocked(`git -C ${DIRTY_TRACKED} ${SUBCOMMAND} ${HARD}`, CLEAN);
    });

    it('resolves a relative -C against the hook input cwd', () => {
      expectResetBlocked(`git -C dirty-tracked ${SUBCOMMAND} ${HARD}`, ROOT);
    });

    it('follows -C through a second -C and a dot-dot', () => {
      expectResetBlocked(`git -C ${ROOT} -C dirty-tracked/sub -C .. ${SUBCOMMAND} ${HARD}`, CLEAN);
    });
  });

  describe('lets it through when nothing is at risk', () => {
    it('on a clean tree', () => {
      expect(runAt(HARD_RESET, CLEAN).status).toBe(0);
    });

    it('on a clean tree named by -C, whatever state the working directory is in', () => {
      expect(runAt(`git -C ${CLEAN} ${SUBCOMMAND} ${HARD}`, DIRTY_TRACKED).status).toBe(0);
    });

    it('in a dirty tree under .claude/worktrees/, which a lane owns outright', () => {
      expect(runAt(HARD_RESET, WORKTREE).status).toBe(0);
    });

    it('in a dirty worktree named by -C, even from a dirty checkout', () => {
      expect(runAt(`git -C ${WORKTREE} ${SUBCOMMAND} ${HARD} HEAD`, DIRTY_TRACKED).status).toBe(0);
    });

    it.each([
      ['a soft reset', `git ${SUBCOMMAND} --soft HEAD`],
      ['a mixed reset', `git ${SUBCOMMAND} --mixed HEAD`],
      ['a reset with no mode', `git ${SUBCOMMAND}`],
      ['unstaging a path', `git ${SUBCOMMAND} HEAD tracked.txt`],
      ['a path that is literally named like the flag', `git ${SUBCOMMAND} -- ${HARD}`],
      ['a commit message that mentions the flag', `git commit -m "undo a ${SUBCOMMAND} ${HARD}"`],
      ['a search for the words', `grep -rn "git ${SUBCOMMAND} ${HARD}" AGENTS.md`],
      ['echoing the words', `echo "run git ${SUBCOMMAND} ${HARD} to start over"`]
    ])('in a dirty tree for %s', (_label, command) => {
      expect(runAt(command, DIRTY_TRACKED).status).toBe(0);
    });
  });

  describe('refuses when it cannot tell which tree the reset acts on', () => {
    it('with no cwd in the hook input', () => {
      const { status, stderr } = feed(JSON.stringify({ tool_input: { command: HARD_RESET } }));
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain('no cwd');
    });

    it('with a cwd that is not a string', () => {
      const { status, stderr } = feed(
        JSON.stringify({ cwd: 42, tool_input: { command: HARD_RESET } })
      );
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain('no cwd');
    });

    it('with a cwd that does not exist', () => {
      expectResetBlocked(HARD_RESET, MISSING);
    });

    it('with a cwd that is a plain directory, not a repository', () => {
      expectResetBlocked(HARD_RESET, ROOT);
    });

    it('with a cwd holding a line break, which cannot be handed on safely', () => {
      expectResetBlocked(HARD_RESET, `${CLEAN}\n`);
    });

    it('after a cd earlier in the same command', () => {
      expectResetBlocked(`cd x && ${HARD_RESET}`, CLEAN);
    });

    it('after a cd into the very tree that is clean', () => {
      expectResetBlocked(`cd ${CLEAN} && ${HARD_RESET}`, WORKTREE);
    });

    it('after a pushd', () => {
      expectResetBlocked(`pushd ${CLEAN}; ${HARD_RESET}`, CLEAN);
    });

    it('with a -C path that does not exist', () => {
      expectResetBlocked(`git -C ${MISSING} ${SUBCOMMAND} ${HARD}`, CLEAN);
    });

    it.each([
      ['a variable', 'git -C $WT ' + SUBCOMMAND + ' ' + HARD],
      ['a variable in quotes', 'git -C "$WT" ' + SUBCOMMAND + ' ' + HARD],
      ['a command substitution', 'git -C $(pwd) ' + SUBCOMMAND + ' ' + HARD],
      ['a tilde', 'git -C ~/work ' + SUBCOMMAND + ' ' + HARD],
      ['a glob', 'git -C /tmp/lane-* ' + SUBCOMMAND + ' ' + HARD],
      ['a quoted path with a space in it', `git -C "${CLEAN} x" ${SUBCOMMAND} ${HARD}`],
      ['an empty path', `git -C "" ${SUBCOMMAND} ${HARD}`]
    ])('with a -C path that is %s', (_label, command) => {
      expectResetBlocked(command, CLEAN);
    });

    it.each([
      ['--git-dir', `git --git-dir=${CLEAN}/.git ${SUBCOMMAND} ${HARD}`],
      ['--work-tree', `git --work-tree=${CLEAN} ${SUBCOMMAND} ${HARD}`],
      ['GIT_DIR in the environment', `GIT_DIR=${CLEAN}/.git ${HARD_RESET}`],
      ['GIT_WORK_TREE exported earlier', `export GIT_WORK_TREE=${CLEAN}; ${HARD_RESET}`]
    ])('with git pointed elsewhere by %s', (_label, command) => {
      expectResetBlocked(command, CLEAN);
    });
  });
});
