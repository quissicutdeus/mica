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
const feed = (input: string, env = HERMETIC, hook = HOOK): Outcome => {
  try {
    execFileSync('/bin/sh', [hook], { input, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
const GH = 'gh ' + 'api';
const REPO = 'repos/o/r';
const RULES = 'rule' + 'sets';
const RULESETS = `${REPO}/${RULES}`;
const BRANCHES = `${REPO}/bran` + 'ches';

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
    ['through the zsh modifier noglob', `noglob ${RUNNER} run | tail`],
    ['through the zsh modifier nocorrect', `nocorrect ${TSC} -p . | tail`],
    ['through zsh |&, which pipes stderr too', `${RUNNER} run |& tail`],
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

/*
 * `gh api` is how an assistant would change branch protection or the repository
 * itself without ever typing `git push`. The method can be spelled several ways
 * and `gh` decides the verb, not the spelling, so each way gets its own case --
 * and a read of the same path has to stay allowed, or the rule is switched off
 * the first time someone needs to list the rulesets.
 */
describe('the Bash guard refuses a gh api call that writes to the repository or its rulesets', () => {
  it.each([
    ['-X PATCH', `${GH} ${REPO} -X PATCH`],
    ['--method PATCH', `${GH} ${REPO} --method PATCH`],
    ['--method=PATCH', `${GH} ${REPO} --method=PATCH`],
    ['-XPATCH with the value glued on', `${GH} ${REPO} -XPATCH`],
    ['-X=PATCH', `${GH} ${REPO} -X=PATCH`],
    ['a lower-case method', `${GH} ${REPO} -X patch`],
    ['a mixed-case method after an =', `${GH} ${REPO} --method=Delete`],
    ['a quoted method', `${GH} ${REPO} -X "PATCH"`],
    ['a single-quoted method after an =', `${GH} ${REPO} --method='PUT'`],
    ['a method flag before the path', `${GH} -X PATCH ${REPO}`],
    ['PUT', `${GH} ${REPO} -X PUT`],
    ['DELETE', `${GH} ${REPO} -X DELETE`],
    ['a method held in a variable, which is not known to be a read', `${GH} ${REPO} -X "$M"`],
    ['a quoted path', `${GH} "${REPO}" -X PATCH`],
    ['a path with a leading slash', `${GH} /${REPO} -X PATCH`],
    ['a path with a trailing slash', `${GH} ${REPO}/ -X PATCH`],
    ['a path with a query string', `${GH} ${REPO}?x=1 -X PATCH`],
    ['a full URL', `${GH} https://api.github.com/${REPO} -X PATCH`],
    ['gh placeholders for the owner and repo', `${GH} repos/{owner}/{repo} --method PATCH`],
    ['two spaces between gh and api', `${GH.replace(' ', '  ')} ${REPO} -X PATCH`],
    ['a tab between gh and api', `${GH.replace(' ', '\t')} ${REPO} -X PATCH`],
    ['a ; inside a quoted argument in front of the method', `${GH} -H 'a;b' ${REPO} -X PATCH`],
    ['a POST that creates a ruleset', `${GH} ${RULESETS} -X POST`],
    ['a ruleset updated by id', `${GH} ${RULESETS}/123 --method=PUT`],
    ['a ruleset deleted by id', `${GH} ${RULESETS}/123 -X DELETE`],
    ['an organization ruleset', `${GH} orgs/o/${RULES} -X POST`],
    ['a ruleset with a lower-case method', `${GH} ${RULESETS} --method=post`],
    [
      'a ruleset created with fields and no method, which gh sends as a POST',
      `${GH} ${RULESETS} -f name=x`
    ],
    ['a ruleset with -F', `${GH} ${RULESETS} -F enforcement=active`],
    ['a ruleset with a flag glued to its value', `${GH} ${RULESETS} -fname=x`],
    ['a ruleset with --field', `${GH} ${RULESETS} --field name=x`],
    ['a ruleset with --raw-field', `${GH} ${RULESETS} --raw-field name=x`],
    ['a ruleset with --input', `${GH} ${RULESETS} --input rule.json`],
    ['a field after a --jq filter that holds a pipe', `${GH} ${RULESETS} --jq '.a | .b' -f name=x`],
    ['a field after a quoted ; in the same call', `${GH} ${RULESETS} -H 'a;b' -f name=x`]
  ])('blocks %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });

  // The verb is decided per call. A GET on one `gh api` must never make a
  // field-only write in another call read as a GET too: the whole-command
  // version of this check did exactly that.
  it.each([
    [
      'a GET, then a field-only write on the repository',
      `${GH} user --method GET && ${GH} ${REPO} -f private=true`
    ],
    [
      'a GET with fields, then a field-only ruleset write',
      `${GH} ${RULESETS} -X GET -f per_page=5; ${GH} ${RULESETS} -f name=x`
    ],
    [
      'a GET right before a ;, then a field-only write to protection',
      `${GH} user -X GET; ${GH} ${BRANCHES}/main/protection -f x=y`
    ],
    ['a GET, then a write after ||', `${GH} user -X GET || ${GH} ${REPO} -f a=b`],
    ['a GET, then a write on the next line', `${GH} user -X GET\n${GH} ${RULESETS} -f name=x`],
    ['a GET piped into an --input write', `${GH} user -X GET | ${GH} ${RULESETS} --input -`],
    [
      'a GET, then a write behind a continuation line',
      `${GH} user -X GET; ${GH} ${RULESETS} \\\n -X POST`
    ],
    [
      'two calls in one quoted command, which cannot be told apart',
      `sh -c '${GH} user -X GET; ${GH} ${RULESETS} -f name=x'`
    ],
    ['two calls in one substitution', `echo $(${GH} user -X GET; ${GH} ${RULESETS} -f name=x)`],
    ['a method flag after a 2>&1 redirect', `${GH} ${REPO} 2>&1 -X PATCH`],
    ['a write inside a substitution', `x=$(${GH} ${RULESETS} -X POST)`],
    ['a field after a quote that never closes', `${GH} ${RULESETS} -f name='x`]
  ])('blocks, deciding per call: %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });

  it.each([
    ['protection updated with PUT', PROTECTION],
    ['protection with --method=PUT', `${GH} ${BRANCHES}/main/protection --method=PUT`],
    ['protection with -XPUT glued on', `${GH} ${BRANCHES}/main/protection -XPUT`],
    ['protection with a lower-case method after -X=', `${GH} ${BRANCHES}/main/protection -X=put`],
    ['protection removed with DELETE', `${GH} ${BRANCHES}/main/protection -X DELETE`],
    ['one protection setting patched', `${GH} ${BRANCHES}/main/protection/enforce_admins -X POST`],
    ['protection set with fields and no method', `${GH} ${BRANCHES}/main/protection -f x=y`],
    [
      'protection set with --input and no method',
      `${GH} ${BRANCHES}/main/protection --input p.json`
    ],
    ['protection with a method held in a variable', `${GH} ${BRANCHES}/main/protection -X "$M"`],
    [
      'protection with a variable method after a GET',
      `${GH} ${BRANCHES}/main/protection -X GET -X "$M"`
    ],
    ['a branch rename', `${GH} ${BRANCHES}/main/rename -X POST -f new_name=x`],
    ['a quoted path with a query string and a write method', `${GH} '${BRANCHES}?x=1' -X DELETE`],
    ['a write under settings', `${GH} ${REPO}/settings -X PATCH`],
    ['fields under settings and no method', `${GH} ${REPO}/settings -f x=y`]
  ])('blocks a write to branches or settings: %s', (_label, command) => {
    expect(run(command)).toBe(BLOCKED);
  });
});

describe('the Bash guard leaves a gh api read alone', () => {
  it.each([
    ['reading the repository', `${GH} ${REPO}`],
    ['reading the repository through a jq filter', `${GH} ${REPO} --jq .default_branch`],
    ['reading the repository with a header', `${GH} ${REPO} -H "Accept: application/json"`],
    ['an explicit GET', `${GH} ${REPO} -X GET`],
    ['an explicit lower-case get after an =', `${GH} ${REPO} --method=get`],
    ['an explicit HEAD', `${GH} ${REPO} -XHEAD`],
    ['listing the rulesets', `${GH} ${RULESETS}`],
    ['listing the rulesets with --paginate', `${GH} --paginate ${RULESETS}`],
    ['reading one ruleset', `${GH} ${RULESETS}/123`],
    ['reading the rulesets through a jq filter with a pipe', `${GH} ${RULESETS} --jq '.[] | .id'`],
    ['reading an organization ruleset', `${GH} orgs/o/${RULES}`],
    ['a GET whose fields are query parameters', `${GH} ${RULESETS} -X GET -f per_page=5`],

    // The branches and settings paths used to be refused whatever the method, so
    // `gh api 'repos/o/r/branches?protected=true' --jq ...` -- how a lane asks
    // which branches are protected -- was blocked as if it were a write.
    ['listing branches', `${GH} ${BRANCHES}`],
    [
      'listing the protected branches through a quoted query and jq',
      `${GH} '${BRANCHES}?protected=true' --jq '.[].name'`
    ],
    ['reading one branch', `${GH} ${BRANCHES}/main`],
    ['reading branch protection', `${GH} ${BRANCHES}/main/protection`],
    [
      'reading branch protection through a jq filter that holds a pipe',
      `${GH} ${BRANCHES}/main/protection --jq '.a | .b'`
    ],
    ['branches with --paginate', `${GH} --paginate ${BRANCHES}`],
    ['branches with an explicit GET', `${GH} ${BRANCHES} -X GET`],
    [
      'branches with --method GET and fields as query parameters',
      `${GH} ${BRANCHES} --method GET -f per_page=100`
    ],
    [
      'branches with -X GET and fields as query parameters',
      `${GH} ${BRANCHES} -X GET -f per_page=100`
    ],
    ['branches with --method=get', `${GH} ${BRANCHES} --method=get`],
    ['branch protection with -XHEAD glued on', `${GH} ${BRANCHES}/main/protection -XHEAD`],
    ['reading under settings', `${GH} ${REPO}/settings`],
    [
      'reading branch protection, then an unrelated rm -f',
      `${GH} ${BRANCHES}/main/protection > x.json; rm -f x.json`
    ],
    ['reading the rulesets, then an unrelated rm -f', `${GH} ${RULESETS} > x.json; rm -f x.json`],
    ['reading the rulesets, then an unrelated force flag', `${GH} ${RULESETS} && ls -f`],
    [
      'writing to a sub-resource, which is not the repository',
      `${GH} ${REPO}/issues -X POST -f title=x`
    ],
    ['deleting a sub-resource', `${GH} ${REPO}/issues/1/comments/2 -X DELETE`],
    ['a gh command that is not api', 'gh pr list --state open'],

    // Each call is judged by its own flags, so a neighbour's do not count.
    [
      'a GET on one call, then a plain read of the rulesets',
      `${GH} user -X GET; ${GH} ${RULESETS}`
    ],
    [
      'a POST on one call, then a plain read of the rulesets',
      `${GH} user -X POST; ${GH} ${RULESETS}`
    ],
    [
      'a read of the rulesets, then fields on a call elsewhere',
      `${GH} ${RULESETS}; ${GH} user -f x=y`
    ],
    ['a ruleset read with stderr merged and piped on', `${GH} ${RULESETS} 2>&1 | head`],
    ['a ruleset read inside a subshell', `(${GH} ${RULESETS} -X GET)`],
    ['a ruleset read inside a substitution', `x=$(${GH} ${RULESETS} -X GET)`],
    ['a GET followed directly by a ;', `${GH} ${RULESETS} -X GET; rm -f x`]
  ])('allows %s', (_label, command) => {
    expect(run(command)).toBe(0);
  });
});

describe('the Bash guard fails closed when its own checks cannot run', () => {
  // Two PATH directories holding almost nothing: node alone, so neither grep nor
  // awk can start, and node plus awk, so only grep cannot.
  const BIN = mkdtempSync(join(tmpdir(), 'bash-guard-bin-'));
  const BIN_AWK = mkdtempSync(join(tmpdir(), 'bash-guard-bin-awk-'));

  beforeAll(() => {
    const awk = execFileSync('sh', ['-c', 'command -v awk'], { encoding: 'utf8' }).trim();
    for (const dir of [BIN, BIN_AWK]) {
      symlinkSync(process.execPath, join(dir, 'node'));
    }
    symlinkSync(awk, join(BIN_AWK, 'awk'));
  });

  afterAll(() => {
    rmSync(BIN, { recursive: true, force: true });
    rmSync(BIN_AWK, { recursive: true, force: true });
  });

  const withPath = (command: string, path: string): Outcome =>
    feed(JSON.stringify({ tool_input: { command } }), { ...HERMETIC, PATH: path });

  it('refuses an ordinary command rather than letting it through unchecked', () => {
    const { status, stderr } = withPath('ls', BIN);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('pipe check');
  });

  it('refuses a gh api call rather than reading it as not a write, with no grep', () => {
    // A read: with grep gone, the only honest answer is "cannot tell", never "fine".
    const { status, stderr } = withPath(`${GH} ${REPO}`, BIN_AWK);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('gh api check');
  });

  it('refuses a gh api call it cannot split into calls, with no awk', () => {
    const { status, stderr } = withPath(`${GH} ${REPO}`, BIN);
    expect(status).toBe(BLOCKED);
    expect(stderr).toContain('could not split');
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

/*
 * A push that moves main is only AGENTS.md §2.1's business when it is THIS
 * repository's main. The hook fires for every repository a session touches, and
 * it once refused a push to the owner's dotfiles -- another repo whose default
 * branch is also main -- after the owner had said yes. It now asks git which
 * repository the push acts on, and fails closed whenever it cannot tell.
 *
 * The "project" is a throwaway repo named by CLAUDE_PROJECT_DIR, so the cases
 * run the same wherever this suite does. Its common dir is what a worktree
 * under `.claude/worktrees/` shares, which is the other shape that must count.
 * Each shape is assembled from parts, like the ones above, so writing this file
 * does not trip the live guard.
 */
const PUSH = 'pu' + 'sh';
const GIT_PUSH = `git ${PUSH}`;
const MAIN = 'ma' + 'in';
const PUSH_MAIN = `${GIT_PUSH} origin ${MAIN}`;
const PUSH_MAIN_QUIET = `${GIT_PUSH} -q origin ${MAIN}`;
const MOVES_MAIN = 'would move ' + MAIN;
/** `git -C <dir> push origin main`. */
const pushIn = (dir: string): string => `git -C ${dir} pu` + `sh origin ${MAIN}`;

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
const GITLINK = '160000,0123456789abcdef0123456789abcdef01234567,subm';
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

const expectAllowed = (command: string, cwd: string, env = mica): void => {
  const { status, stderr } = runAt(command, cwd, env);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
};

describe('the Bash guard and a push that moves main', () => {
  beforeAll(() => {
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
  });

  afterAll(() => {
    rmSync(MP_ROOT, { recursive: true, force: true });
  });

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
      ['a plus before the name', `${GIT_PUSH} origin +${MAIN}`],
      ['the full ref', `${GIT_PUSH} origin refs/heads/${MAIN}`],
      ['a plus and the full ref', `${GIT_PUSH} origin +refs/heads/${MAIN}`],
      ['a source and the full ref', `${GIT_PUSH} origin dev:refs/heads/${MAIN}`],
      ['a source and the name', `${GIT_PUSH} origin dev:${MAIN}`],
      ['every branch', `${GIT_PUSH} --all origin`],
      ['a mirror', `${GIT_PUSH} --mirror origin`],
      ['the name quoted', `${GIT_PUSH} origin "${MAIN}"`],
      ['an option with a value in front', `${GIT_PUSH} -o ci.skip forgejo ${MAIN}`]
    ])('blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
    });

    it.each([
      ['a remote of any name', `${GIT_PUSH} forgejo ${MAIN}`],
      ['every branch', `${GIT_PUSH} --all origin`],
      ['a plus before the name', `${GIT_PUSH} origin +${MAIN}`]
    ])('lets %s through in another repository', (_label, command) => {
      expectAllowed(command, OTHER);
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
      ['a plus and heads/', `${GIT_PUSH} origin +heads/${MAIN}`],
      ['an empty destination, which is a matching push', `${GIT_PUSH} origin :`],
      ['a plus and an empty destination', `${GIT_PUSH} origin +:`],
      ['a source and an empty destination', `${GIT_PUSH} origin dev:`]
    ])('blocks %s', (_label, command) => {
      expectMainBlocked(command, MICA);
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
