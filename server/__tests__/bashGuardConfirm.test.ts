// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BLOCKED, FORCE, HERMETIC, MAIN, PUSH, mainPushFixture, runAt } from './bashGuardHarness';

/**
 * The owner's one-time confirmation for moving main (`mp_try_token` in the guard). The guard
 * cannot read the conversation, so an owner who said yes in chat was refused every time and the
 * only way past was switching the guard off. A confirmation file in the git dir now lets exactly
 * one plain fast-forward of main through, to exactly the commit it names, within 15 minutes,
 * and is used up by it. Everything else about moving main is refused as before.
 *
 * The path and the push shapes are assembled from parts, like the other guard suites, so writing
 * this file does not trip the live guard.
 */

const { MICA, WT_MAIN, mica, expectForceBlocked, setup, teardown } = mainPushFixture();

const CONFIRM_DIR = 'mica-' + 'confirm';
const TOKEN = (): string => join(MICA, '.git', CONFIRM_DIR, 'move-main');
const QUOTE = 'Do #2';

const shaOf = (dir: string, ref: string): string =>
  execFileSync('git', ['-C', dir, 'rev-parse', ref], { env: HERMETIC, encoding: 'utf8' }).trim();

const now = (): number => Math.floor(Date.now() / 1000);

type Token = { sha?: string; created?: number | string; expires?: number | string; quote?: string };

const writeToken = (fields: Token = {}, extra = ''): void => {
  const t = now();
  const {
    sha = shaOf(MICA, `refs/heads/${MAIN}`),
    created = t,
    expires = t + 600,
    quote = QUOTE
  } = fields;
  mkdirSync(join(MICA, '.git', CONFIRM_DIR), { recursive: true });
  writeFileSync(
    TOKEN(),
    `sha=${sha}\ncreated=${String(created)}\nexpires=${String(expires)}\nquote=${quote}\n${extra}`
  );
};

const pushMain = (args = `origin ${MAIN}`): string => `git -C ${MICA} ${PUSH} ${args}`;

/**
 * The hook run directly, keeping stderr on success too: the harness's `runAt` drops it when the
 * hook exits 0, and an allowed push is the one case whose message matters.
 */
const runKeepingStderr = (command: string): { status: number | null; stderr: string } => {
  const result = spawnSync('/bin/sh', ['.claude/hooks/block-dangerous-bash.sh'], {
    input: JSON.stringify({ cwd: MICA, tool_input: { command } }),
    env: mica,
    encoding: 'utf8'
  });
  return { status: result.status, stderr: result.stderr };
};

const expectRefused = (command: string, reason: string, cwd = MICA): void => {
  const { status, stderr } = runAt(command, cwd, mica);
  expect(status).toBe(BLOCKED);
  expect(stderr).toContain(reason);
};

describe('the Bash guard and the owner confirmation for moving main', () => {
  beforeAll(setup);
  afterAll(teardown);
  beforeEach(() => rmSync(TOKEN(), { force: true }));

  it('refuses a push to main with no confirmation, as before', () => {
    expectRefused(pushMain(), 'would move ' + MAIN);
  });

  it('lets one plain push through on a valid confirmation, says why, and uses it up', () => {
    writeToken();
    const { status, stderr } = runKeepingStderr(pushMain());
    expect(status).toBe(0);
    expect(stderr).toContain("on the owner's confirmation");
    expect(stderr).toContain(`"${QUOTE}"`);
    expect(existsSync(TOKEN())).toBe(false);
    // Used up: the same push again is refused.
    expectRefused(pushMain(), 'would move ' + MAIN);
  });

  it.each([
    ['refs/heads/main', `origin refs/heads/${MAIN}`],
    ['<src>:main', `origin HEAD:${MAIN}`],
    ['<src>:refs/heads/main', `origin HEAD:refs/heads/${MAIN}`]
  ])('allows the %s spelling to the named commit', (_label, args) => {
    writeToken();
    const { status } = runAt(pushMain(args), MICA, mica);
    expect(status).toBe(0);
    expect(existsSync(TOKEN())).toBe(false);
  });

  it.each([
    ['a file', `origin ${MAIN} > out.log`],
    ['a file, attached', `origin ${MAIN} >out.log`],
    ['an append', `origin ${MAIN} >> /tmp/out.log`],
    ['stderr to a file', `origin ${MAIN} 2>/tmp/err.log`],
    ['stderr into stdout', `origin ${MAIN} >/tmp/out.log 2>&1`],
    ['both, bash-style', `origin HEAD:${MAIN} &>/tmp/out.log`]
  ])('allows the push with its output redirected to %s', (_label, args) => {
    writeToken();
    const { status } = runAt(pushMain(args), MICA, mica);
    expect(status).toBe(0);
    expect(existsSync(TOKEN())).toBe(false);
  });

  it.each([
    ['a redirect with no target', `origin ${MAIN} >`, 'no target'],
    ['a target the shell would expand', `origin ${MAIN} >$OUT`, 'plain path'],
    ['an input redirect', `origin ${MAIN} </dev/null`, 'covers only'],
    ['a here-string', `origin ${MAIN} <<<x`, 'covers only']
  ])('refuses %s even with a valid confirmation', (_label, args, reason) => {
    writeToken();
    expectRefused(pushMain(args), reason);
    expect(existsSync(TOKEN())).toBe(true);
  });

  it('allows the push from a worktree of the project, which shares its git dir', () => {
    writeToken();
    const { status } = runAt(`git -C ${WT_MAIN} ${PUSH} origin ${MAIN}`, MICA, mica);
    expect(status).toBe(0);
    expect(existsSync(TOKEN())).toBe(false);
  });

  it('refuses a confirmation that names another commit, and says which', () => {
    writeToken({ sha: 'a'.repeat(40) });
    expectRefused(pushMain(), `names ${'a'.repeat(40)} but this push sends`);
    expect(existsSync(TOKEN())).toBe(true);
  });

  it.each<[string, Token, string, string?]>([
    ['an expired one', { created: now() - 1200, expires: now() - 60 }, 'expired'],
    ['one valid for more than 15 minutes', { expires: now() + 3600 }, 'more than 15 minutes'],
    ['a short sha', { sha: 'abc1234' }, '40-character'],
    ['an upper-case sha', { sha: 'A'.repeat(40) }, '40-character'],
    ['an empty quote', { quote: '' }, 'quotes no words'],
    ['a created time that is not a number', { created: 'soon' }, 'created time'],
    ['an expiry that is not a number', { expires: 'later' }, 'expiry'],
    ['an unknown line', {}, 'does not know', 'remote=origin\n']
  ])('refuses %s', (_label, fields, reason, extra) => {
    writeToken(fields, extra ?? '');
    expectRefused(pushMain(), reason);
  });

  it.each([
    ['an option', `-q origin ${MAIN}`, 'covers only'],
    ['a second refspec', `origin ${MAIN} dev`, 'covers only'],
    ['a deletion by option', `origin --delete ${MAIN}`, 'covers only'],
    ['a deletion by empty source', `origin :${MAIN}`, 'does not cover the source'],
    ['a remote that is a path', `../elsewhere ${MAIN}`, 'plain remote name'],
    ['a source the guard cannot read', `origin $X:${MAIN}`, 'would move ' + MAIN]
  ])('refuses %s even with a valid confirmation', (_label, args, reason) => {
    writeToken();
    expectRefused(pushMain(args), reason);
  });

  it('refuses a force-push of main with a valid confirmation, and leaves it unused', () => {
    writeToken();
    expectForceBlocked(pushMain(`${FORCE} origin ${MAIN}`), MICA);
    expectForceBlocked(pushMain(`origin +${MAIN}`), MICA);
    expect(existsSync(TOKEN())).toBe(true);
  });

  it('refuses a mirror push with a valid confirmation', () => {
    writeToken();
    const { status } = runAt(pushMain('--mirror origin'), MICA, mica);
    expect(status).toBe(BLOCKED);
    expect(existsSync(TOKEN())).toBe(true);
  });

  it('refuses writing the confirmation and pushing in one command', () => {
    expectRefused(
      `mkdir -p ${join(MICA, '.git', CONFIRM_DIR)} && printf x > ${TOKEN()} && ${pushMain()}`,
      'touches the main-push confirmation'
    );
  });
});
