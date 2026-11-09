// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED,
  FORCE,
  GIT_PUSH,
  MAIN,
  PUSH,
  PUSH_MAIN,
  SKIP_HOOKS,
  feed,
  mainPushFixture,
  runAt
} from './bashGuardHarness';

/**
 * The second half of the Bash guard's push-that-moves-main rule, which asks git which repository
 * a push acts on. The first half is in `bashGuardReset.test.ts`; each file builds fixtures of its
 * own, so the two run in parallel.
 */

const {
  MP_ROOT,
  MICA,
  MICA_WORKTREE,
  OTHER,
  WT_MAIN,
  WT_DETACHED,
  SUPER,
  SUPER_CFG,
  PLAIN,
  NOWHERE,
  mica,
  expectMainBlocked,
  expectForceBlocked,
  expectAllowed,
  setup,
  teardown
} = mainPushFixture();

describe('the Bash guard and a push that moves main', () => {
  beforeAll(setup);

  afterAll(teardown);

  /*
   * A redirection is the shell's, not git's. The guard once read `> $S/push.log` as a
   * refspec holding a variable it could not read, and refused a push of dev to the
   * project's own origin from a session that merely logged its output. The
   * assignment-only segment in front of it (`S=...;`) was not the cause: it only
   * makes a later `~` unsure, and this command has none.
   */
  describe('does not read a redirection as a remote or a refspec', () => {
    const DEV_PUSH = `${GIT_PUSH} -q origin dev`;

    it.each([
      [
        'the reported command: cd, an assignment, a push to a variable log, a tail of it',
        `cd ${MICA} && S=/tmp/scratch; ${DEV_PUSH} > $S/rex-push.log 2>&1; echo rc=$?; tail -3 $S/rex-push.log`
      ],
      [
        'the same without the cd',
        `S=/tmp/scratch; ${DEV_PUSH} > $S/rex-push.log 2>&1; echo rc=$?; tail -3 $S/rex-push.log`
      ],
      ['the plain form, with no redirect at all', DEV_PUSH],
      ['a literal target', `${DEV_PUSH} > /tmp/push.log 2>&1`],
      ['a variable target', `${DEV_PUSH} > $S/push.log`],
      ['a quoted variable target', `${DEV_PUSH} > "$S/push.log"`],
      ['a target glued to the operator', `${DEV_PUSH} >$S/push.log`],
      ['an append', `${DEV_PUSH} >> $S/push.log`],
      ['an append of stderr', `${DEV_PUSH} 2>> $S/push.log`],
      ['stderr to a variable file', `${DEV_PUSH} 2> $S/push.err`],
      ['both streams, &>', `${DEV_PUSH} &> $S/push.log`],
      ['both streams, >&', `${DEV_PUSH} >& $S/push.log`],
      ['stderr into stdout, then away', `${DEV_PUSH} 2>&1 >/dev/null`],
      ['an input redirect', `${DEV_PUSH} < /dev/null`],
      ['a redirect before the branch', `${GIT_PUSH} -q origin > $S/push.log dev`],
      ['a clobbering redirect', `${DEV_PUSH} >| $S/push.log`]
    ])('lets %s through', (_label, command) => {
      expectAllowed(command, MICA);
    });

    it.each([
      ['a push of main with a redirect', `${PUSH_MAIN} > $S/push.log`],
      ['a push of main with a literal redirect', `${PUSH_MAIN} > /tmp/push.log 2>&1`],
      ['a refspec after a redirect and a dup', `${DEV_PUSH} 2>&1 >/dev/null ${MAIN}`],
      ['a refspec after a spaced redirect', `${DEV_PUSH} > /tmp/push.log ${MAIN}`],
      ['a refspec after a glued redirect', `${DEV_PUSH} >/tmp/push.log ${MAIN}`],
      ['a variable refspec after a redirect', `${DEV_PUSH} > $S/push.log $B`],
      ['an option that pushes everything, after a redirect', `${DEV_PUSH} > /tmp/push.log --all`],
      ['a quoted operator, which is a word git receives', `${DEV_PUSH} ">" ${MAIN}`],
      ['a redirect on its own as the last word', `${PUSH_MAIN} >`]
    ])('still blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it.each([
      ['a remote and a redirect target', `${GIT_PUSH} origin > $S/push.log`],
      ['a remote only, redirected', `${GIT_PUSH} origin 2>&1`],
      ['no arguments, redirected', `${GIT_PUSH} > /tmp/push.log`],
      ['an input redirect and a remote', `${GIT_PUSH} origin < /dev/null`]
    ])(
      'does not count a redirect target as the branch: %s still pushes the current one',
      (_label, command) => {
        expectMainBlocked(command, WT_MAIN);
      }
    );

    it('still lets a redirected push of another repository through', () => {
      expectAllowed(`${GIT_PUSH} origin ${MAIN} > $S/push.log`, OTHER);
    });
  });

  describe('sees every way of naming main, and a push that names no branch', () => {
    it.each([
      ['a remote of any name', `${GIT_PUSH} forgejo ${MAIN}`],
      ['the full ref', `${GIT_PUSH} origin refs/heads/${MAIN}`],
      ['a source and the full ref', `${GIT_PUSH} origin dev:refs/heads/${MAIN}`],
      ['a source and the name', `${GIT_PUSH} origin dev:${MAIN}`],
      ['every branch', `${GIT_PUSH} --all origin`],
      ['the name quoted', `${GIT_PUSH} origin "${MAIN}"`],
      ['an option with a value in front', `${GIT_PUSH} -o ci.skip forgejo ${MAIN}`]
    ])('blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    // A `+` refspec and --mirror are force-pushes, and a force-push is refused
    // whatever repository it is aimed at (AGENTS.md §2.1), so these are refused
    // by the force rule before the main rule is asked, in this repository and in
    // any other. The message is the force rule's, not "would move main".
    it.each([
      ['a plus before the name', `${GIT_PUSH} origin +${MAIN}`],
      ['a plus and the full ref', `${GIT_PUSH} origin +refs/heads/${MAIN}`],
      ['a mirror', `${GIT_PUSH} --mirror origin`]
    ])('blocks %s as a force-push', (_label, command) => {
      expectForceBlocked(command, MICA);
    });

    it.each([
      ['a remote of any name', `${GIT_PUSH} forgejo ${MAIN}`],
      ['every branch', `${GIT_PUSH} --all origin`]
    ])('lets %s through in another repository', (_label, command) => {
      expectAllowed(command, OTHER);
    });

    it('blocks a plus before the name in another repository too: a + push is a force-push anywhere', () => {
      expectForceBlocked(`${GIT_PUSH} origin +${MAIN}`, OTHER);
    });

    it.each([
      ['no arguments at all', GIT_PUSH],
      ['a remote only', `${GIT_PUSH} origin`],
      ['flags only', `${GIT_PUSH} -u`],
      ['a flag and a remote', `${GIT_PUSH} -u origin`],
      ['HEAD', `${GIT_PUSH} origin HEAD`],
      ['@', `${GIT_PUSH} origin @`]
    ])('blocks a push with %s while the tree is on main', (_label, command) => {
      expectMainBlocked(command, WT_MAIN);
    });

    it('blocks a bare push aimed at a worktree that is on main, by -C and by cd', () => {
      expectMainBlocked(`git -C ${WT_MAIN} ${PUSH}`, OTHER);
      expectMainBlocked(`cd ${WT_MAIN} && ${GIT_PUSH}`, OTHER);
    });

    it('blocks a bare push whose current branch cannot be read', () => {
      expectMainBlocked(GIT_PUSH, WT_DETACHED);
    });

    it.each([
      ['a cwd that does not exist', NOWHERE],
      ['a cwd that is not a repository', PLAIN],
      ['a cwd that is not absolute', 'mica']
    ])('blocks a bare push with %s', (_label, cwd) => {
      expectMainBlocked(GIT_PUSH, cwd);
    });

    it('blocks a bare push with no cwd', () => {
      const { status, stderr } = feed(JSON.stringify({ tool_input: { command: GIT_PUSH } }), mica);
      expect(status).toBe(BLOCKED);
      expect(stderr).toContain('no cwd');
    });

    it('blocks a bare push after something that could have moved the shell', () => {
      expectMainBlocked(`pnpm build && ${GIT_PUSH}`, OTHER);
    });

    it.each([
      ['no arguments, on a branch that is not main', GIT_PUSH, MICA],
      ['a remote only, on a branch that is not main', `${GIT_PUSH} origin`, MICA_WORKTREE],
      ['HEAD, on a branch that is not main', `${GIT_PUSH} origin HEAD`, MICA],
      ['no arguments, in another repository', GIT_PUSH, OTHER],
      ['a named branch, from the worktree on main', `${GIT_PUSH} origin dev`, WT_MAIN],
      ['a refspec to another branch', `${GIT_PUSH} origin HEAD:dev`, WT_MAIN]
    ])('lets a push with %s through', (_label, command, cwd) => {
      expectAllowed(command, cwd);
    });
  });

  describe('reads the destination of a refspec the way git does', () => {
    it.each([
      ['heads/ without refs/', `${GIT_PUSH} origin heads/${MAIN}`],
      ['a source and heads/', `${GIT_PUSH} origin dev:heads/${MAIN}`],
      ['an empty destination, which is a matching push', `${GIT_PUSH} origin :`],
      ['a source and an empty destination', `${GIT_PUSH} origin dev:`]
    ])('blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    // A leading `+` makes these force-pushes, refused by the force rule first.
    it.each([
      ['a plus and heads/', `${GIT_PUSH} origin +heads/${MAIN}`],
      ['a plus and an empty destination', `${GIT_PUSH} origin +:`]
    ])('blocks %s as a force-push', (_label, command) => {
      expectForceBlocked(command, MICA);
    });

    it.each([
      ['heads/ without refs/', `${GIT_PUSH} origin heads/${MAIN}`],
      ['an empty destination', `${GIT_PUSH} origin :`]
    ])('lets %s through in another repository', (_label, command) => {
      expectAllowed(command, OTHER);
    });

    it('does not mistake a destination that merely starts with main', () => {
      expectAllowed(`${GIT_PUSH} origin HEAD:${MAIN}tenance`, MICA);
      expectAllowed(`${GIT_PUSH} origin ${MAIN}tenance`, MICA);
    });
  });

  describe('lines up a push whose options take values, or refuses', () => {
    it.each([
      ['a short -o clustered with a flag', `${GIT_PUSH} -qo x origin`],
      ['a short -o and its value', `${GIT_PUSH} -o x origin`],
      ['--push-option and its value', `${GIT_PUSH} --push-option x origin`],
      ['--receive-pack and its value', `${GIT_PUSH} --receive-pack x origin`],
      ['--exec and its value', `${GIT_PUSH} --exec x origin`],
      ['--repo and its value', `${GIT_PUSH} --repo x`],
      [
        '--recurse-submodules and a separate value',
        `${GIT_PUSH} --recurse-submodules check origin`
      ],
      ['--signed', `${GIT_PUSH} --signed origin`],
      ['a quoted git', `'git' ${PUSH} origin`],
      ['a double-quoted git', `"git" ${PUSH} origin`],
      ['an escaped git', `\\git ${PUSH} origin`],
      ['an option it does not know', `${GIT_PUSH} --frobnicate origin`],
      ['an abbreviation, which git accepts for --all', `${GIT_PUSH} --al origin`],
      ['a short letter it does not know', `${GIT_PUSH} -qx origin dev`],
      ['an option that is missing its value', `${GIT_PUSH} -o`]
    ])('blocks a push with %s while the tree is on main', (_label, command) => {
      expectMainBlocked(command, WT_MAIN);
    });

    it.each([
      ['an abbreviation, which git accepts for --all', `${GIT_PUSH} --al origin`],
      ['an option it does not know', `${GIT_PUSH} --frobnicate origin dev`],
      ['a short letter it does not know', `${GIT_PUSH} -qx origin dev`]
    ])('blocks %s even off main, since it may name main', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it('does not read an option value as the remote or a refspec', () => {
      expectAllowed(`${GIT_PUSH} -qo x origin dev`, WT_MAIN);
      expectAllowed(`${GIT_PUSH} -o x origin dev`, WT_MAIN);
      expectAllowed(`${GIT_PUSH} --recurse-submodules=check origin dev`, WT_MAIN);
      expectAllowed(`${GIT_PUSH} --receive-pack x origin dev`, WT_MAIN);
    });

    it.each([
      ['a backslash in git options', `git -\\C ${OTHER} ${PUSH}`],
      ['a subcommand held in a variable', 'git $SUB ' + PUSH],
      ['an escaped subcommand', `git \\${PUSH}`]
    ])('refuses %s', (_label, command) => {
      // These mention a push but do not line up with git's grammar.
      const { status } = runAt(command, WT_MAIN, mica);
      expect(status).toBe(BLOCKED);
    });
  });

  describe('does not trust a tilde once the command has assigned something', () => {
    // The hook's HOME puts `~/mica` at an unrelated repository, so a HOME the
    // command changed first is the only thing that can make it the project.
    it('passes the decoy when nothing was assigned, which is what makes the rest meaningful', () => {
      expectAllowed(`git -C ~/mica ${PUSH} origin ${MAIN}`, MICA);
    });

    it.each([
      ['HOME set on an earlier line', `HOME=${MP_ROOT}; git -C ~/mica ${PUSH} origin ${MAIN}`],
      ['HOME exported first', `export HOME=${MP_ROOT}; git -C ~/mica ${PUSH} origin ${MAIN}`],
      ['HOME set for the command itself', `HOME=${MP_ROOT} git -C ~/mica ${PUSH} origin ${MAIN}`],
      ['HOME set with &&', `HOME=${MP_ROOT} && git -C ~/mica ${PUSH} origin ${MAIN}`],
      ['any other bare assignment', `X=1; git -C ~/mica ${PUSH} origin ${MAIN}`],
      ['a leading cd on a tilde', `HOME=${MP_ROOT}; cd ~/mica && ${PUSH_MAIN}`]
    ])('blocks after %s', (_label, command) => {
      expectMainBlocked(command, OTHER);
    });
  });

  describe('treats a push that recurses into submodules as acting on this repository', () => {
    it.each([
      ['on-demand', `${GIT_PUSH} --recurse-submodules=on-demand origin ${MAIN}`],
      ['only', `${GIT_PUSH} --recurse-submodules=only origin ${MAIN}`],
      ['a separate value', `${GIT_PUSH} --recurse-submodules on-demand origin ${MAIN}`],
      [
        'a -c config on the command line',
        `git -c push.recurseSubmodules=on-demand ${PUSH} origin ${MAIN}`
      ]
    ])('blocks %s from a superproject that lists a submodule', (_label, command) => {
      expectMainBlocked(command, SUPER);
    });

    it('blocks it by -C and by cd as well', () => {
      expectMainBlocked(
        `git -C ${SUPER} ${PUSH} --recurse-submodules=on-demand origin ${MAIN}`,
        OTHER
      );
      expectMainBlocked(
        `cd ${SUPER} && ${GIT_PUSH} --recurse-submodules=only origin ${MAIN}`,
        OTHER
      );
    });

    it('blocks it when push.recurseSubmodules is set in the superproject', () => {
      expectMainBlocked(PUSH_MAIN, SUPER_CFG);
    });

    it('lets a push through that does not recurse', () => {
      expectAllowed(PUSH_MAIN, SUPER);
      expectAllowed(`${GIT_PUSH} --recurse-submodules=check origin ${MAIN}`, SUPER);
    });

    it('lets a recursing push through from a tree with no submodule', () => {
      expectAllowed(`${GIT_PUSH} --recurse-submodules=on-demand origin ${MAIN}`, OTHER);
    });

    it('lets a recursing push that names a branch through', () => {
      expectAllowed(`${GIT_PUSH} --recurse-submodules=on-demand origin dev`, SUPER);
    });
  });

  describe('lets through what has always been allowed, and what only looked like main', () => {
    it.each([
      ['a push of a named branch', `${GIT_PUSH} origin dev`],
      ['a quiet push of a named branch', `${GIT_PUSH} -q origin dev`],
      ['a full ref to a ticket branch', `${GIT_PUSH} origin HEAD:refs/heads/MICA-56`],
      ['a delete of a ticket branch', `${GIT_PUSH} origin --delete MICA-56`],
      ['a bare push on a branch that is not main', GIT_PUSH],
      ['an upstream push of a ticket branch', `${GIT_PUSH} -u origin MICA-56`],
      ['a destination that only starts with main', `${GIT_PUSH} origin HEAD:${MAIN}tenance`],
      [
        'a log of main followed by a push of dev',
        `git log origin ${MAIN}..dev && ${GIT_PUSH} origin dev`
      ],
      ['a push of dev after a mention of main', `git log origin ${MAIN}; ${GIT_PUSH} origin dev`]
    ])('allows %s', (_label, command) => {
      expectAllowed(command, MICA);
    });
  });

  describe('keeps the other push rules for every repository', () => {
    it.each([
      ['a force-push', `${GIT_PUSH} ${FORCE} origin dev`],
      ['a force-push to main', `${GIT_PUSH} ${FORCE} origin ${MAIN}`],
      ['the flag that skips hooks', `git commit ${SKIP_HOOKS} -m x`]
    ])('refuses %s from an unrelated repository', (_label, command) => {
      expect(runAt(command, OTHER, mica).status).toBe(BLOCKED);
    });

    it('still lets an ordinary push from the project through', () => {
      expectAllowed(`${GIT_PUSH} origin dev`, MICA);
    });
  });
});
