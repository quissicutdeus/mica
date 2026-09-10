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
