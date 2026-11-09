// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED,
  BRANCHES,
  ESLINT,
  FORCE,
  GH,
  HERMETIC,
  KNIP,
  PLAYWRIGHT,
  PM,
  PRETTIER,
  PROTECTION,
  PS_ARRAY,
  REPO,
  REPO_LOCATORS,
  RULES,
  RULESETS,
  RUNNER,
  SKIP_HOOKS,
  TO_DEFAULT,
  TSC,
  VERIFY_SCRIPT,
  feed,
  run,
  withoutRepoLocators,
  type Outcome
} from './bashGuardHarness';

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

describe('the fixtures never inherit a repository locator', () => {
  it('strips every variable that names the repository', () => {
    const polluted = Object.fromEntries(REPO_LOCATORS.map((key) => [key, '/the/real/repo']));
    expect(withoutRepoLocators({ ...polluted, KEEP: 'me' })).toEqual({ KEEP: 'me' });
  });

  it('leaves none of them in the environment handed to git and the hook', () => {
    for (const key of REPO_LOCATORS) expect(HERMETIC[key]).toBeUndefined();
  });
});

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

/*
 * The force rule judges the push's own arguments, not the whole chain. A `-f`
 * that belongs to checkout, clean or rm in the same command is not a force-push
 * (the first case below is a real command that was refused for it), and every
 * real force form must stay refused wherever it sits in a chain.
 */
const SHORT_F = '-' + 'f';
const SHORT_FU = '-' + 'fu';
const LEASE = FORCE + '-with-lease';
const INCLUDES = FORCE + '-if-includes';
const PLUS_REF = '+' + 'HEAD:refs/heads/dev';
const MIRROR = '--mir' + 'ror';

describe('the Bash guard reads only the push for a force flag', () => {
  it.each([
    [
      'a push by refspec after a checkout with its own force flag',
      `cd /repo && W=/tmp/w && git -C $W checkout -q ${SHORT_F} --detach 9216d818 && git -C $W clean -fdq && git -C $W status --short | wc -l && git -C $W push origin 9216d818:refs/heads/dev > $W/../p.log 2>&1; echo rc=$?; tail -2 $W/../p.log`
    ],
    ['a checkout -f before a plain push', `git checkout ${SHORT_F} x && git push origin dev`],
    ['an rm -f before a plain push', `rm ${SHORT_F} x.log; git push origin dev`],
    ['a force flag after the push in another command', `git push origin dev; rm ${SHORT_F} x`],
    ['a push by refspec', 'git -C /tmp/w push origin 9216d818:refs/heads/dev'],
    ['a push with -u', 'git push -u origin dev'],
    ['a push-option value', 'git push -o ci.skip origin dev']
  ])('allows %s', (_label, command) => {
    expect(run(command)).toBe(0);
  });

  it.each([
    ['--force', `git push ${FORCE} origin dev`],
    ['-f', `git push ${SHORT_F} origin dev`],
    ['-f last', `git push origin dev ${SHORT_F}`],
    ['a combined short flag', `git push ${SHORT_FU} origin dev`],
    ['--force-with-lease', `git push ${LEASE} origin dev`],
    ['--force-with-lease=ref', `git push ${LEASE}=dev origin dev`],
    ['--force-if-includes', `git push ${INCLUDES} origin dev`],
    ['an abbreviated long flag', `git push --for origin dev`],
    ['a + refspec', `git push origin ${PLUS_REF}`],
    ['--mirror', `git push ${MIRROR} backup`],
    [
      'a force push after a harmless command in a chain',
      `git status && git push ${SHORT_F} origin dev`
    ],
    ['a force push followed by a harmless command', `git push ${FORCE} origin dev; echo done`],
    ['a force push after git -C', `git -C /tmp/w push ${FORCE} origin dev`],
    [
      'a force push after a checkout -f in the same chain',
      `git checkout ${SHORT_F} x && git push ${SHORT_F} origin dev`
    ],
    ['a force push through sudo', `sudo git push ${SHORT_F} origin dev`],
    ['a force push inside sh -c', `sh -c 'git push ${FORCE} origin dev'`]
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
