// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED,
  GIT_PUSH,
  HARD,
  HARD_RESET,
  HERMETIC,
  MAIN,
  MOVES_MAIN,
  PUSH,
  PUSH_MAIN,
  PUSH_MAIN_QUIET,
  SUBCOMMAND,
  TO_DEFAULT,
  git,
  mainPushFixture,
  feed,
  makeRepo,
  modifyTracked,
  pushIn,
  runAt
} from './bashGuardHarness';

/**
 * The Bash guard's two rules that ask git about a real repository (`bashGuard.test.ts` holds the
 * ones that read the command's text alone): a hard reset over uncommitted work, and the first half
 * of a push that moves main. The other half is `bashGuardPush.test.ts`.
 */

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

const {
  MP_ROOT,
  MICA,
  MICA_SUB,
  MICA_WORKTREE,
  OTHER,
  LINK,
  WT_MAIN,
  REPO_HOME,
  DOTFILES,
  PLAIN,
  NOWHERE,
  STANDALONE,
  mica,
  unnamed,
  expectMainBlocked,
  expectAllowed,
  setup,
  teardown
} = mainPushFixture();

describe('the Bash guard and a push that moves main', () => {
  beforeAll(setup);

  afterAll(teardown);

  describe('blocks it when the push acts on this repository', () => {
    it.each([
      ['the project checkout', MICA],
      ['a subdirectory of it', MICA_SUB],
      ['a worktree under .claude/worktrees/, which shares its common dir', MICA_WORKTREE]
    ])('with the working directory in %s', (_label, cwd) => {
      expectMainBlocked(PUSH_MAIN, cwd);
    });

    it.each([
      ['an absolute -C', pushIn(MICA)],
      ['a -C to a worktree', pushIn(MICA_WORKTREE)],
      ['a relative -C, against the working directory', pushIn('../mica')],
      ['a -C through ~ that lands in the project', pushIn('~/../mica')],
      ['a leading cd into it', `cd ${MICA} && ${PUSH_MAIN}`],
      ['a leading cd into it, with ;', `cd ${MICA}; ${PUSH_MAIN}`],
      ['a leading cd into a worktree of it', `cd ${MICA_WORKTREE} && ${PUSH_MAIN}`]
    ])('from another repository, through %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });

    it("when a later push in the same command is the project's", () => {
      expectMainBlocked(`${pushIn(OTHER)} && ${PUSH_MAIN}`, MICA_SUB);
    });

    it("when the first push is the project's and a later one is not", () => {
      expectMainBlocked(`${PUSH_MAIN} && ${pushIn(OTHER)}`, MICA);
    });

    it("through the script's own location when CLAUDE_PROJECT_DIR is not set", () => {
      // The hook under test lives in this very checkout, so its project is this
      // repository: a push from here must be refused with no env to say so.
      expectMainBlocked(PUSH_MAIN, process.cwd(), unnamed);
    });
  });

  describe('refuses when it cannot tell which repository the push acts on', () => {
    it('with no cwd in the hook input', () => {
      const { status, stderr } = feed(JSON.stringify({ tool_input: { command: PUSH_MAIN } }), mica);
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain(MOVES_MAIN);
      expect(stderr).toContain('no cwd');
    });

    it('with no cwd, even when -C names an unrelated repository', () => {
      const { status, stderr } = feed(
        JSON.stringify({ tool_input: { command: pushIn(OTHER) } }),
        mica
      );
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain(MOVES_MAIN);
    });

    it('with a cwd that is not an absolute path', () => {
      expectMainBlocked(PUSH_MAIN, 'other');
    });

    it('with a cwd that does not exist', () => {
      expectMainBlocked(PUSH_MAIN, NOWHERE);
    });

    it('with a cwd that is a plain directory, not a repository', () => {
      expectMainBlocked(PUSH_MAIN, PLAIN);
    });

    it.each([
      ['a variable', 'git -C $WT pu' + `sh origin ${MAIN}`],
      ['a variable in quotes', 'git -C "$WT" pu' + `sh origin ${MAIN}`],
      ['a command substitution', 'git -C $(pwd) pu' + `sh origin ${MAIN}`],
      ['a glob', pushIn(`${MP_ROOT}/oth*`)],
      ['a quoted path with a space in it', pushIn(`"${OTHER} x"`)],
      ['an empty path', pushIn('""')],
      ['a quoted tilde, which the shell leaves alone', pushIn('"~/dotfiles"')],
      ["another user's home", pushIn('~someone/dotfiles')],
      ['a directory that does not exist', pushIn(NOWHERE)],
      ['a directory that is not a repository', pushIn(PLAIN)]
    ])('with a -C path that is %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });

    it.each([
      ['a cd to a variable', `cd $DIR && ${PUSH_MAIN}`],
      ['a cd to a substitution', `cd $(pwd) && ${PUSH_MAIN}`],
      ['a cd to a directory that does not exist', `cd ${NOWHERE} && ${PUSH_MAIN}`],
      ['a cd to a directory that does not exist, then ;', `cd ${NOWHERE}; ${PUSH_MAIN}`],
      ['a cd to a quoted tilde', `cd "~/dotfiles" && ${PUSH_MAIN}`],
      ['a bare cd', `cd && ${PUSH_MAIN}`],
      ['a cd with an option', `cd -P ${OTHER} && ${PUSH_MAIN}`],
      ['a cd that may not run before the push', `cd ${OTHER} || ${PUSH_MAIN}`],
      ['a cd that runs in the background', `cd ${OTHER} & ${PUSH_MAIN}`],
      ['a cd that feeds a pipe', `cd ${OTHER} | ${PUSH_MAIN}`],
      ['a second cd', `cd ${OTHER} && cd ${MICA} && ${PUSH_MAIN}`],
      ['a cd that is not the opening command', `echo go && cd ${OTHER} && ${PUSH_MAIN}`],
      ['a cd in a subshell that has already closed', `(cd ${OTHER}); ${PUSH_MAIN}`],
      ['a pushd', `pushd ${OTHER} && ${PUSH_MAIN}`]
    ])('after %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it.each([
      ['--git-dir', `git --git-dir=${OTHER}/.git pu` + `sh origin ${MAIN}`],
      ['--work-tree', `git --work-tree=${OTHER} pu` + `sh origin ${MAIN}`],
      ['GIT_DIR in the environment', `GIT_DIR=${OTHER}/.git ${PUSH_MAIN}`],
      ['GIT_WORK_TREE exported earlier', `export GIT_WORK_TREE=${OTHER}; ${PUSH_MAIN}`]
    ])('with git pointed elsewhere by %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });

    it("with GIT_DIR in the hook's own environment", () => {
      expectMainBlocked(PUSH_MAIN, OTHER, { ...mica, GIT_DIR: join(OTHER, '.git') });
    });

    it.each([
      ['through sudo', `sudo ${PUSH_MAIN}`],
      ['through sh -c', `sh -c '${PUSH_MAIN}'`],
      ['inside a substitution of something else', `echo $(${PUSH_MAIN})`],
      ['after a command that could move the shell', `pnpm build && ${PUSH_MAIN}`],
      ['after a command that is not plainly inert', `. ./env.sh && ${PUSH_MAIN}`],
      ['named by a commit message, not run', `git commit -m "document ${PUSH_MAIN}"`],
      ['named by an echo', `echo "${PUSH_MAIN}"`]
    ])('for a push reached %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });

    it('when CLAUDE_PROJECT_DIR does not resolve to a repository', () => {
      expectMainBlocked(PUSH_MAIN, OTHER, { ...mica, CLAUDE_PROJECT_DIR: PLAIN });
    });

    it('when no project can be found at all', () => {
      // A copy of the hook in a tree with no repository above it, and no env: it
      // cannot say what it protects, so it protects everything.
      const { status, stderr } = feed(
        JSON.stringify({ cwd: OTHER, tool_input: { command: PUSH_MAIN } }),
        unnamed,
        STANDALONE
      );
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain(MOVES_MAIN);
    });
  });

  describe('lets it through only when the push is placed in another repository', () => {
    it.each([
      ['an unrelated repository', OTHER],
      ['a repository under the home directory', DOTFILES]
    ])('with the working directory in %s', (_label, cwd) => {
      expectAllowed(PUSH_MAIN, cwd);
    });

    it.each([
      ['an upstream remote', `${GIT_PUSH} upstream ${MAIN}`],
      ['a refspec', `${GIT_PUSH} origin HEAD:${MAIN}`],
      ['the full ref', `${GIT_PUSH} origin ${TO_DEFAULT}`],
      ['quiet flags', PUSH_MAIN_QUIET],
      ['an env assignment in front', `GIT_SSH_COMMAND=ssh ${PUSH_MAIN}`]
    ])('with %s', (_label, command) => {
      expectAllowed(command, OTHER);
    });

    it.each([
      ['an absolute -C, from the project', pushIn(OTHER), MICA],
      ['a relative -C, against the working directory', pushIn('../other'), MICA],
      [
        'a second -C that lands in another repository',
        `git -C ${MICA} -C ../other pu` + `sh origin ${MAIN}`,
        MICA
      ],
      ['a -C written with ~, expanded against HOME', pushIn('~/dotfiles'), MICA],
      ['a leading cd, with &&', `cd ${OTHER} && ${PUSH_MAIN}`, MICA],
      ['a leading cd, with ;', `cd ${OTHER}; ${PUSH_MAIN}`, MICA],
      ['a leading cd to a ~ path', `cd ~/dotfiles && ${PUSH_MAIN}`, MICA],
      ['a leading cd to a quoted path', `cd "${OTHER}" && ${PUSH_MAIN}`, MICA],
      ['a leading cd to a relative path', `cd ../other && ${PUSH_MAIN}`, MICA],
      ['a leading cd followed by a relative -C', `cd ~ && ${pushIn('dotfiles')}`, MICA],
      ['inert commands in front of it', `echo go; ${pushIn(OTHER)}`, MICA],
      ['anything at all after the last push', `${pushIn(OTHER)} && pnpm exec whatever`, MICA],
      [
        'every push in the command aimed elsewhere',
        `${pushIn(OTHER)} && ${pushIn(DOTFILES)}`,
        MICA
      ],
      [
        'the whole shape a session writes: cd, add, commit, push',
        `cd ~/dotfiles && git add -A && git commit -q -m "tidy" && ${PUSH_MAIN_QUIET}`,
        MICA
      ]
    ])('through %s', (_label, command, cwd) => {
      expectAllowed(command, cwd);
    });

    it('through a -C to a bare ~ that is itself a repository', () => {
      expectAllowed(pushIn('~'), MICA, { ...mica, HOME: REPO_HOME });
    });

    it("through the script's own location when CLAUDE_PROJECT_DIR is not set", () => {
      expectAllowed(PUSH_MAIN, OTHER, unnamed);
    });
  });

  describe('resolves a cd the way the shell does, not the way git -C would', () => {
    // MICA/L is a symlink to OTHER/sub. The shell's `cd ./L/..` is logical and
    // ends back in MICA; git -C on the same text is physical and would land in
    // OTHER -- so a guard that handed the text to git let this through.
    it.each([
      ['a ./ path through the link and back out', `cd ./L/.. && ${PUSH_MAIN}`],
      ['an absolute path through the link and back out', `cd ${LINK}/.. && ${PUSH_MAIN}`],
      ['a bare word through the link, which CDPATH could send anywhere', `cd L/.. && ${PUSH_MAIN}`]
    ])('blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it.each([
      ['a bare word, which CDPATH could resolve elsewhere', `cd sub && ${PUSH_MAIN}`],
      ['a bare word naming another repository', `cd other && ${PUSH_MAIN}`]
    ])('refuses %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it('follows the link when the cd really does end in the other repository', () => {
      expectAllowed(`cd ./L && ${PUSH_MAIN}`, MICA);
    });
  });

  describe('reads git options the way git does, or refuses', () => {
    it.each([
      [
        'a quoted -c value that swallows the subcommand',
        `git -c 'a.b=c ${PUSH}' -C ${MICA} ${PUSH} origin ${MAIN}`
      ],
      ['the same with a bare push', `git -c 'a.b=c ${PUSH}' -C ${MICA} ${PUSH}`],
      ['a double-quoted one', `git -c "a.b=c ${PUSH}" -C ${MICA} ${PUSH} origin ${MAIN}`],
      ['a quoted subcommand', `git -C ${MICA} "${PUSH}" origin ${MAIN}`],
      ['a quoted option', `git "-C" ${MICA} ${PUSH} origin ${MAIN}`],
      ['a -C path with a space in it', `git -C "${OTHER} x" ${PUSH} origin ${MAIN}`]
    ])('refuses %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });

    it('still reads a -C path that is quoted as a whole', () => {
      expectAllowed(`git -C "${OTHER}" ${PUSH} origin ${MAIN}`, MICA);
    });

    it('still reads a plain -c option', () => {
      expectAllowed(`git -c core.quotepath=off -C ${OTHER} ${PUSH} origin ${MAIN}`, MICA);
    });
  });

  describe('judges every push in the command, not only the last one naming main', () => {
    it.each([
      ['a variable refspec after one aimed elsewhere', `${pushIn(OTHER)}; ${GIT_PUSH} origin $B`],
      ['a substitution refspec', `${pushIn(OTHER)}; ${GIT_PUSH} origin $(echo x)`],
      [
        'a refspec that lands on refs/heads/main',
        `${pushIn(OTHER)} && ${GIT_PUSH} origin dev:${TO_DEFAULT.slice(5)}`
      ],
      ['one aimed at the project first', `${PUSH_MAIN} && ${pushIn(OTHER)}`],
      ['a bare push on main after one aimed elsewhere', `${pushIn(OTHER)}; ${GIT_PUSH}`]
    ])('with %s', (_label, command) => {
      expectMainBlocked(command, command.endsWith(GIT_PUSH) ? WT_MAIN : MICA);
    });

    it('lets a variable refspec through when it acts on another repository', () => {
      expectAllowed(`${GIT_PUSH} origin $B`, OTHER);
    });
  });
});
