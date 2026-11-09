// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';

/**
 * The repo's own assistant config parses, and says who it is.
 *
 * This exists because all five agent definitions in `.claude/agents/` were silently
 * dropped for as long as they had existed. Each `description:` was an unquoted multi-line
 * YAML scalar containing `": "` — a colon-space inside a plain scalar ends the key, so the
 * frontmatter was not valid YAML, so the whole block failed to parse, so the agent had no
 * name and was never registered. `subagent_type: rakata` answered "not found" while
 * `CLAUDE.md` documented routing work to exactly that name. Nothing failed. Nothing warned.
 * The work simply went to a general-purpose agent carrying none of the rules the definition
 * exists to deliver, which is the most expensive kind of quiet: it looks like it worked.
 *
 * The whole class is invisible by construction. Assistant config is not compiled, not
 * imported, not linted and not typechecked — `prettier` formats these files and
 * `markdownlint` reads their prose, and neither one parses the YAML between the fences. So
 * this suite is the only thing standing behind them.
 *
 * It asserts three things, and the third is the one that catches a rename:
 *
 *   1. the frontmatter is valid YAML at all,
 *   2. `name` and `description` are present and non-empty,
 *   3. `name` matches where the file lives — the filename stem for an agent, the directory
 *      name for a skill. A definition whose declared name has drifted from its path is
 *      addressable by neither reliably.
 *
 * And it refuses to pass on an empty directory. A glob that matches nothing reports zero
 * failures, which is indistinguishable from success and is the shape of every check this
 * repo has had to relearn.
 */

const ROOT = join(__dirname, '..', '..');
const AGENTS_DIR = join(ROOT, '.claude', 'agents');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const MEMORY_DIR = join(ROOT, '.claude', 'agent-memory');

/**
 * The agent types that write no code, and so are the only ones allowed to go without
 * `lane-protocol`: `lead` is the main session, where `skills:` preloads nothing; `review`
 * reads a diff and changes nothing; `verify` runs the gates and changes nothing. Every other
 * agent is a lane by default, so a new agent type is held to the rule unless it is added
 * here on purpose.
 */
const NON_CODE_AGENTS = ['lead', 'review', 'verify'];

/**
 * The colours Claude Code's agent frontmatter accepts. A value outside this set is not an
 * error there; it is the default colour, which is to say no colour, silently.
 */
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

interface Definition {
  /** Path relative to the repo root, for a failure message that names the file. */
  label: string;
  /** The name this file's location says it should declare. */
  expectedName: string;
  path: string;
}

/**
 * The YAML between the first pair of `---` fences.
 *
 * `null` means the file has no frontmatter block at all, which is a different failure from
 * a block that does not parse and is reported differently below.
 */
const frontmatterOf = (text: string): string | null => {
  // The opening fence must be the first line; a `---` further down is a horizontal rule.
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(text.indexOf('\n', 3) + 1, end);
};

/**
 * The parsed frontmatter, or `{}` when there is none. Only for checks layered on top of
 * the parse test below — that one reports a missing or malformed block as what it is.
 */
const frontOf = (path: string): Record<string, unknown> =>
  (parse(frontmatterOf(readFileSync(path, 'utf8')) ?? '') ?? {}) as Record<string, unknown>;

/** The prose after the frontmatter — what the agent is actually told. */
const bodyOf = (text: string): string => {
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(end + 4);
};

const agentDefinitions = (): Definition[] =>
  readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => ({
      label: `.claude/agents/${entry}`,
      expectedName: basename(entry, '.md'),
      path: join(AGENTS_DIR, entry)
    }));

const skillDefinitions = (): Definition[] =>
  readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      label: `.claude/skills/${entry.name}/SKILL.md`,
      // A skill is addressed by its directory, not its filename — every file is SKILL.md.
      expectedName: entry.name,
      path: join(SKILLS_DIR, entry.name, 'SKILL.md')
    }));

const definitions = [...agentDefinitions(), ...skillDefinitions()];

describe('assistant config', () => {
  it('finds agent and skill definitions to check', () => {
    // Without this, deleting `.claude/agents/` would turn this suite green.
    expect(agentDefinitions().length).toBeGreaterThan(0);
    expect(skillDefinitions().length).toBeGreaterThan(0);
  });

  it.each(definitions)('$label parses and names itself', ({ label, expectedName, path }) => {
    expect(existsSync(path), `${label} is missing`).toBe(true);

    const raw = frontmatterOf(readFileSync(path, 'utf8'));
    expect(raw, `${label} has no --- frontmatter block, so it is never registered`).not.toBe(null);

    let parsed: unknown;
    try {
      parsed = parse(raw as string);
    } catch (error) {
      // The original bug, reported as the thing it actually is. An unquoted multi-line
      // scalar containing ": " is the specific trap; `description: >-` or a quoted string
      // is the fix.
      throw new Error(
        `${label}: frontmatter is not valid YAML, so this definition is silently ignored.\n` +
          `${(error as Error).message}\n` +
          'A `description:` spanning several lines must use a block scalar (`>-`) or be ' +
          'quoted — an unquoted scalar containing ": " is not valid YAML.'
      );
    }

    expect(parsed, `${label}: frontmatter is not a mapping`).toBeTypeOf('object');
    const front = parsed as Record<string, unknown>;

    expect(typeof front.name, `${label}: no \`name\``).toBe('string');
    expect(String(front.name).trim(), `${label}: empty \`name\``).not.toBe('');
    expect(front.name, `${label}: declares name "${front.name}" but lives at ${label}`).toBe(
      expectedName
    );

    // The description is what routes work here — an agent or skill with none is invisible
    // to the thing choosing between them, which is barely better than not parsing.
    expect(typeof front.description, `${label}: no \`description\``).toBe('string');
    expect(String(front.description).trim(), `${label}: empty \`description\``).not.toBe('');

    // A misspelt `model` or `effort` does not fail anything either — the agent just runs on
    // the session's model and effort, which is the expensive default these keys exist to
    // override. Both are optional; a value that is present must be one Claude Code accepts.
    if (front.model !== undefined) {
      expect(
        String(front.model),
        `${label}: \`model: ${front.model}\` is not an alias, a model id, or inherit`
      ).toMatch(/^(inherit|opus|sonnet|haiku|fable|claude-[a-z0-9-]+)$/);
    }
    if (front.effort !== undefined) {
      expect(
        ['low', 'medium', 'high', 'xhigh', 'max'],
        `${label}: \`effort: ${front.effort}\` is not a level Claude Code accepts`
      ).toContain(front.effort);
    }

    // The rest of the frontmatter fails the same silent way. A `memory` scope Claude Code
    // does not know is no memory; a `skills` entry naming no skill preloads nothing; a
    // `color` it does not recognise is the default colour; a `tools` list that is not a
    // list is ignored. None of them errors, so each is checked here.
    if (front.memory !== undefined) {
      expect(
        ['user', 'project', 'local'],
        `${label}: \`memory: ${front.memory}\` is not a scope Claude Code accepts`
      ).toContain(front.memory);
    }
    if (front.color !== undefined) {
      expect(
        AGENT_COLORS,
        `${label}: \`color: ${front.color}\` is not a colour Claude Code accepts`
      ).toContain(front.color);
    }
    if (front.skills !== undefined) {
      expect(Array.isArray(front.skills), `${label}: \`skills\` must be a list`).toBe(true);
      for (const skill of front.skills as unknown[]) {
        expect(
          existsSync(join(SKILLS_DIR, String(skill), 'SKILL.md')),
          `${label}: preloads skill "${skill}", which does not exist under .claude/skills/`
        ).toBe(true);
      }
    }
    for (const key of ['tools', 'disallowedTools']) {
      const value = front[key];
      if (value === undefined) continue;
      const wellFormed =
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      expect(wellFormed, `${label}: \`${key}\` must be a string or a list of strings`).toBe(true);
    }
  });

  /**
   * An agent whose body tells it that `.claude/agent-memory/<name>/` loads on every run,
   * while its frontmatter declares no `memory:` scope, is the quietest failure in this
   * file: nothing loads, the agent writes what it learns into a directory nothing reads,
   * and every run re-discovers the same trap. Two agents shipped exactly that way, with
   * real findings sitting unread in the directory the whole time.
   */
  it('every agent whose body relies on agent memory declares a memory scope', () => {
    // Its own directory, not any mention: `review` reads the other agents' indexes and keeps
    // none of its own, which is a different promise.
    const reliant = agentDefinitions().filter(({ expectedName, path }) =>
      bodyOf(readFileSync(path, 'utf8')).includes(`.claude/agent-memory/${expectedName}/`)
    );
    // A filter that matches nothing would pass the loop below for free.
    expect(
      reliant.length,
      'no agent body mentions agent-memory — has the wording moved out from under this?'
    ).toBeGreaterThan(0);
    for (const { label, path } of reliant) {
      expect(
        frontOf(path).memory,
        `${label}: the body says .claude/agent-memory/ loads for this agent, but the ` +
          'frontmatter declares no `memory:` scope, so nothing loads and its notes are ' +
          'read by nobody'
      ).toBeDefined();
    }
  });

  /**
   * `lane-protocol` is how a lane starts on the tree it was given, never resets the shared
   * checkout under its siblings, names its logs so a sibling cannot overwrite them, and
   * shapes the report the lead reads. It reaches an agent only through that agent's
   * `skills:` list. An agent type that leaves it out gets none of it, and nothing fails —
   * the lane just runs without the rules, on whatever tree it happens to be on.
   *
   * The exemptions are held by name, and each must exist on disk: a renamed `review` would
   * otherwise leave an exemption for nobody, and the stale name would read as coverage.
   */
  it('every code-writing agent preloads lane-protocol', () => {
    const agents = agentDefinitions();
    const names = agents.map(({ expectedName }) => expectedName);
    for (const exempt of NON_CODE_AGENTS) {
      expect(
        names,
        `NON_CODE_AGENTS exempts "${exempt}" from lane-protocol, but there is no ` +
          `.claude/agents/${exempt}.md — the exemption covers nobody; update the list`
      ).toContain(exempt);
    }

    const lanes = agents.filter(({ expectedName }) => !NON_CODE_AGENTS.includes(expectedName));
    // Every agent exempted, or none on disk, would pass the loop below for free.
    expect(lanes.length, 'no code-writing agent found to check').toBeGreaterThan(0);
    for (const { label, path } of lanes) {
      const skills = frontOf(path).skills;
      expect(
        Array.isArray(skills) ? skills : [],
        `${label}: writes code but does not preload \`lane-protocol\` in \`skills:\`, so it ` +
          'starts on whatever tree it lands on, can reset the shared checkout, and reports ' +
          'in no shape the lead expects. Add it, or add the agent to NON_CODE_AGENTS if it ' +
          'genuinely writes nothing'
      ).toContain('lane-protocol');
    }
  });

  /**
   * `.claude/agent-memory/<name>/` is read only for an agent named `<name>` that declares
   * `memory: project` — `user` reads `~/.claude/agent-memory/` and `local` reads
   * `.claude/agent-memory-local/`, so neither one loads this directory either. A directory
   * with no such agent behind it is notes nobody reads, which is how two agents' real
   * findings sat unread (see the test above). The reverse fails as quietly: an agent that
   * declares the scope but has no `MEMORY.md` loads nothing, because the index is the file
   * that loads, not the directory.
   */
  it('agent-memory directories and memory: project declarations match', () => {
    const dirs = readdirSync(MEMORY_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    // An empty or missing tree would pass both loops below for free.
    expect(dirs.length, '.claude/agent-memory/ holds no agent directories').toBeGreaterThan(0);

    const agents = new Map(agentDefinitions().map((agent) => [agent.expectedName, agent]));
    for (const dir of dirs) {
      const agent = agents.get(dir);
      expect(
        agent,
        `.claude/agent-memory/${dir}/ exists, but there is no .claude/agents/${dir}.md — ` +
          'notes for an agent that does not exist are read by nobody'
      ).toBeDefined();
      expect(
        agent && frontOf(agent.path).memory,
        `.claude/agent-memory/${dir}/ exists, but .claude/agents/${dir}.md does not declare ` +
          '`memory: project`, so the directory never loads and its notes are read by nobody'
      ).toBe('project');
    }

    for (const { label, expectedName, path } of agents.values()) {
      if (frontOf(path).memory !== 'project') continue;
      expect(
        existsSync(join(MEMORY_DIR, expectedName, 'MEMORY.md')),
        `${label}: declares \`memory: project\`, but .claude/agent-memory/${expectedName}/` +
          'MEMORY.md does not exist — the index is the file that loads, so this agent ' +
          'starts every run with no memory'
      ).toBe(true);
    }
  });

  /**
   * Claude Code (2.1.319, bundled CLI: `var lm="MEMORY.md",XN=200,Wee=25000`) loads only the
   * first 200 lines / 25,000 characters of an agent's `MEMORY.md` and drops the rest
   * silently — no error, the tail of the index is just never read. It trims the text, counts
   * lines as newlines + 1 and size as string length; this counts the same way. The cap here
   * is lower (150 / 20,000) so there is headroom: an index that grows past the CLI's limit
   * loses entries without any gate noticing, and this is the only one that does.
   */
  it('every agent-memory index stays under the CLI load limit, with headroom', () => {
    const MAX_LINES = 150;
    const MAX_CHARS = 20_000;
    const indexes = readdirSync(MEMORY_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        label: `.claude/agent-memory/${entry.name}/MEMORY.md`,
        path: join(MEMORY_DIR, entry.name, 'MEMORY.md')
      }))
      .filter(({ path }) => existsSync(path));
    // No index found would pass the loop below for free.
    expect(indexes.length, 'no agent-memory MEMORY.md found to measure').toBeGreaterThan(0);
    for (const { label, path } of indexes) {
      const text = readFileSync(path, 'utf8').trim();
      const lines = text.split('\n').length;
      expect(
        lines,
        `${label} is ${lines} lines; the cap is ${MAX_LINES} (the CLI silently drops past 200)`
      ).toBeLessThanOrEqual(MAX_LINES);
      expect(
        text.length,
        `${label} is ${text.length} characters; the cap is ${MAX_CHARS} (the CLI silently drops past 25,000)`
      ).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  /**
   * `lead-protocol`'s `## Models` table is the written record of what each agent runs on and
   * why. A table that drifts from the frontmatter is a record nobody can trust, and the
   * frontmatter is what actually runs, so each row is held to it: the same set of agents, and
   * the same model and effort for each.
   */
  it("lead-protocol's Models table matches each agent's model and effort", () => {
    const skill = readFileSync(join(SKILLS_DIR, 'lead-protocol', 'SKILL.md'), 'utf8');
    const start = skill.search(/^## Models\s*$/mu);
    expect(start, 'lead-protocol/SKILL.md has no `## Models` section').toBeGreaterThanOrEqual(0);
    const rest = skill.slice(start).replace(/^## Models\s*$/mu, '');
    const next = rest.search(/^## /mu);
    const section = next === -1 ? rest : rest.slice(0, next);

    const rows = section
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) =>
        line
          .trim()
          .replace(/^\||\|$/gu, '')
          .split('|')
          .map((cell) => cell.trim())
      )
      // The header and the `| --- |` rule are not agents; an agent cell is a backticked name.
      .filter((cells) => /^`[a-z0-9-]+`$/u.test(cells[0] ?? ''))
      .map(([agent, model, effort]) => ({
        agent: (agent as string).slice(1, -1),
        model: model ?? '',
        effort: effort ?? ''
      }));
    expect(rows.length, 'the `## Models` section holds no table rows').toBeGreaterThan(0);

    const declared = new Map(
      agentDefinitions()
        .map(({ expectedName, path }) => [expectedName, frontOf(path)] as const)
        .filter(([, front]) => front.model !== undefined)
    );
    expect(declared.size, 'no agent declares a `model:`').toBeGreaterThan(0);

    const tabled = new Set(rows.map((row) => row.agent));
    for (const name of declared.keys()) {
      expect(
        tabled.has(name),
        `agent "${name}" declares \`model:\` but has no row in the Models table`
      ).toBe(true);
    }
    for (const row of rows) {
      const front = declared.get(row.agent);
      expect(
        front,
        `Models table names "${row.agent}", which declares no \`model:\` (or has no agent file)`
      ).toBeDefined();
      expect(
        `${row.model} / ${row.effort}`,
        `Models table row for "${row.agent}" says "${row.model} / ${row.effort}" but ` +
          `.claude/agents/${row.agent}.md declares "${String(front?.model)} / ${String(front?.effort)}"`
      ).toBe(`${String(front?.model)} / ${String(front?.effort)}`);
    }
  });

  /**
   * `lane-protocol` tells a lane to report by `SendMessage`. A `tools:` allowlist is
   * exhaustive, so an agent that preloads the protocol and lists tools without `SendMessage`
   * is told to do something it cannot, and its report has nowhere to go.
   */
  it('a lane with a tools allowlist can SendMessage', () => {
    const allowlisted = agentDefinitions()
      .map(({ label, path }) => ({ label, front: frontOf(path) }))
      .filter(
        ({ front }) =>
          Array.isArray(front.skills) &&
          front.skills.includes('lane-protocol') &&
          front.tools !== undefined
      );
    // An allowlist is the exception; if none exists the check is checking nothing, which
    // is fine only because the rule then has nothing to apply to.
    for (const { label, front } of allowlisted) {
      const tools = Array.isArray(front.tools)
        ? (front.tools as string[])
        : String(front.tools).split(',');
      expect(
        tools.map((tool) => tool.trim()),
        `${label}: preloads lane-protocol, which reports by SendMessage, but its \`tools:\` ` +
          'allowlist omits SendMessage, so the lane cannot report'
      ).toContain('SendMessage');
      // SendMessage reaches a subagent deferred even when its allowlist names it: a docs
      // probe on 2026-11-08 found it absent from its callable tools and had to load it
      // through ToolSearch before the send went through.
      expect(
        tools.map((tool) => tool.trim()),
        `${label}: lists SendMessage but not ToolSearch, and SendMessage arrives deferred, ` +
          'so without ToolSearch the lane cannot load it'
      ).toContain('ToolSearch');
    }
  });

  /**
   * `CLAUDE.md` is the routing table: the lead reads its list to pick an agent type or a
   * skill, and a name missing from it is one the lead never picks. The list uses one bullet
   * shape for agents and skills alike, so the check is over the union — every name on disk
   * is listed, and every name listed is on disk. A rename that updates one side and not the
   * other fails here instead of quietly routing work to `general-purpose`.
   */
  it('CLAUDE.md lists every agent and skill on disk, and nothing else', () => {
    const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const listed = [...claudeMd.matchAll(/^- `([a-z0-9-]+)` — /gmu)]
      .map((match) => match[1])
      .sort();
    expect(listed.length, 'CLAUDE.md has no `- `name` — …` routing list').toBeGreaterThan(0);

    const onDisk = definitions.map(({ expectedName }) => expectedName).sort();
    expect(listed).toEqual(onDisk);
  });

  /**
   * `CLAUDE.md` is what Claude Code reads. A root `AGENTS.md` is inert unless imported, so
   * deleting either this file or its one `@AGENTS.md` line switches off every rule in the
   * repo at once, with no error — which was proposed in earnest once, on the reasonable-
   * looking grounds that `CLAUDE.md` is a stub that only points somewhere else.
   */
  it('CLAUDE.md still imports AGENTS.md', () => {
    const claudeMd = join(ROOT, 'CLAUDE.md');
    expect(existsSync(claudeMd), 'CLAUDE.md is missing — every rule in AGENTS.md is off').toBe(
      true
    );

    /**
     * The import **directive**: `@AGENTS.md` alone on its own line.
     *
     * A substring search is not enough, and this was caught by trying to break it: the
     * warning at the top of `CLAUDE.md` quotes `` `@AGENTS.md` `` in prose, so a
     * `toContain` check went on passing after the real directive had been removed. The
     * gate was reading its own documentation as evidence of the thing it documents.
     */
    const importsAgents = readFileSync(claudeMd, 'utf8')
      .split('\n')
      .some((line) => line.trim() === '@AGENTS.md');

    expect(
      importsAgents,
      'CLAUDE.md no longer has `@AGENTS.md` on a line of its own — every rule in AGENTS.md ' +
        'is switched off, silently. Mentioning it in prose does not import it.'
    ).toBe(true);

    expect(existsSync(join(ROOT, 'AGENTS.md')), 'AGENTS.md is missing').toBe(true);
  });
});
