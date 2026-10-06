// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ADDON_SERVICE_FORMAT_VERSION,
  ADDON_SERVICE_LIMITS,
  addonActionSchemas,
  addonError,
  addonInputSchema,
  addonOutput,
  checkAddonService,
  defineAddonService,
  type AddonActionInput,
  type AddonActionOutput,
  type AddonHandlers
} from '@mica/shared/addonService';
import { SchemaError, parseInput } from '@mica/shared/schema';

/**
 * The add-on service declaration (MICA-308): the one table both an add-on's resource and its
 * UI read. These hold its two jobs — refusing a declaration that is not one, and turning one
 * that is into the same `s` validators core contracts use.
 *
 * The `expectTypeOf` lines document inference but prove nothing here, because no tsconfig reads
 * a test file; the compiled proof is `integration/scenarios/addonService.ts`, which
 * `pnpm typecheck:integration` checks.
 */

const reason = (raw: unknown): string => {
  const checked = checkAddonService(raw);
  if (checked.ok) throw new Error('expected a refusal');
  return checked.reason;
};

const decl = (input: unknown) => ({ id: 'journal', actions: { create: { input } } });

const parse = (input: Record<string, unknown>, value: unknown) =>
  parseInput(addonInputSchema(input as never), value);

describe('a declaration that is one', () => {
  const journal = defineAddonService({
    id: 'journal',
    actions: {
      create: {
        input: {
          title: { type: 'string', max: 80 },
          body: { type: 'string', max: 2000, optional: true }
        }
      },
      list: { input: {}, output: addonOutput<{ id: number; title: string }[]>() }
    }
  });

  it('is returned unchanged, so the object the author wrote is the one that crosses', () => {
    expect(journal.id).toBe('journal');
    expect(journal.actions.list.output).toBeUndefined();
    expect(ADDON_SERVICE_FORMAT_VERSION).toBe(1);
  });

  it('is deep-frozen, so nothing can change the id after it was traced', () => {
    // ES modules are strict, so a write to a frozen property throws rather than doing nothing.
    expect(() => Object.assign(journal, { id: 'other' })).toThrow(TypeError);
    expect(() => {
      (journal as { id: string }).id = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (journal.actions as Record<string, unknown>).extra = { input: {} };
    }).toThrow(TypeError);
    expect(() => {
      (journal.actions.create.input.title as { max: number }).max = 1e9;
    }).toThrow(TypeError);
    expect(journal.id).toBe('journal');
    expect(Object.keys(journal.actions)).toEqual(['create', 'list']);
    expect(journal.actions.create.input.title.max).toBe(80);
    expect(Object.isFrozen(journal.actions.create.input)).toBe(true);
  });

  it('infers each action input and output', () => {
    expectTypeOf<AddonActionInput<typeof journal, 'create'>>().toEqualTypeOf<{
      title: string;
      body?: string;
    }>();
    expectTypeOf<AddonActionOutput<typeof journal, 'list'>>().toEqualTypeOf<
      { id: number; title: string }[]
    >();
    expectTypeOf<AddonHandlers<typeof journal>>().toHaveProperty('create');
  });

  it('normalizes a copy carrying only what was checked', () => {
    const checked = checkAddonService({ ...journal, format: 1 });
    expect(checked).toEqual({
      ok: true,
      value: {
        id: 'journal',
        actions: {
          create: {
            input: {
              title: { type: 'string', max: 80 },
              body: { type: 'string', max: 2000, optional: true }
            }
          },
          list: { input: {} }
        }
      }
    });
  });

  it('reads a Lua empty table, which crosses as [], as {}', () => {
    const checked = checkAddonService({ id: 'journal', actions: { list: { input: [] } } });
    expect(checked).toEqual({
      ok: true,
      value: { id: 'journal', actions: { list: { input: {} } } }
    });
  });

  it('refuses a non-empty list where a map is expected, and an empty actions list', () => {
    expect(reason({ id: 'journal', actions: { list: { input: [{ type: 'boolean' }] } } })).toMatch(
      /must be a table of fields/
    );
    expect(reason({ id: 'journal', actions: [{ input: {} }] })).toMatch(/at least one action/);
    expect(reason({ id: 'journal', actions: [] })).toMatch(/at least one action/);
  });

  it('takes every kind with every option', () => {
    const checked = checkAddonService(
      decl({
        s: { type: 'string', min: 1, max: 10, optional: true, nullable: true },
        i: { type: 'integer', min: -5, max: 5, nullable: true },
        n: { type: 'number', min: 0.5, max: 9.5, optional: true },
        b: { type: 'boolean', optional: true, nullable: true },
        e: { type: 'enum', values: ['a', 'b'], nullable: true },
        a: { type: 'array', of: { type: 'integer', nullable: true }, min: 1, max: 3 }
      })
    );
    expect(checked.ok).toBe(true);
  });

  it('refuses a defineAddonService that is not one, naming why', () => {
    expect(() => defineAddonService({ id: 'Journal', actions: { list: { input: {} } } })).toThrow(
      /defineAddonService\('Journal'\).*lower_snake_case/
    );
  });
});

describe('a declaration that is not one is refused with the reason', () => {
  it('refuses an unknown key, at every level', () => {
    expect(reason({ id: 'journal', actions: { a: { input: {} } }, owner: 'x' })).toMatch(
      /'owner' is not a declaration option/
    );
    expect(reason({ id: 'journal', actions: { a: { input: {}, handler: 1 } } })).toMatch(
      /'handler' is not an action option/
    );
    expect(reason(decl({ t: { type: 'string', max: 5, maxx: 6 } }))).toMatch(
      /'maxx' is not an option of a string field/
    );
    // An option of another kind is unknown to this one.
    expect(reason(decl({ t: { type: 'boolean', max: 1 } }))).toMatch(/'max' is not an option/);
  });

  it('refuses an unknown kind, and a nested object by name', () => {
    expect(reason(decl({ t: { type: 'date' } }))).toMatch(/unknown type 'date'.*no nested objects/);
    expect(reason(decl({ t: { type: 'object', fields: {} } }))).toMatch(/unknown type 'object'/);
    expect(reason(decl({ t: { title: { type: 'string', max: 5 } } }))).toMatch(
      /unknown type 'undefined'/
    );
    expect(
      reason(
        decl({
          t: { type: 'array', of: { type: 'array', of: { type: 'boolean' }, max: 1 }, max: 1 }
        })
      )
    ).toMatch(/entries cannot be arrays/);
  });

  it('refuses a string or an array with no max', () => {
    expect(reason(decl({ t: { type: 'string' } }))).toMatch(/'max' is required/);
    expect(reason(decl({ t: { type: 'array', of: { type: 'boolean' } } }))).toMatch(
      /'max' is required/
    );
    expect(
      reason(decl({ t: { type: 'string', max: ADDON_SERVICE_LIMITS.stringMax + 1 } }))
    ).toMatch(/at most 65535/);
    expect(reason(decl({ t: { type: 'string', max: -1 } }))).toMatch(/whole number, 0 or more/);
    expect(reason(decl({ t: { type: 'string', min: 9, max: 3 } }))).toMatch(/'min' is larger/);
  });

  it('refuses an empty, repeated or non-string enum', () => {
    expect(reason(decl({ t: { type: 'enum', values: [] } }))).toMatch(/non-empty list/);
    expect(reason(decl({ t: { type: 'enum', values: ['a', ''] } }))).toMatch(/non-empty string/);
    expect(reason(decl({ t: { type: 'enum', values: ['a', 1] } }))).toMatch(/non-empty string/);
    expect(reason(decl({ t: { type: 'enum', values: ['a', 'a'] } }))).toMatch(/listed twice/);
  });

  it('refuses bad numbers and flags', () => {
    expect(reason(decl({ t: { type: 'integer', min: 1.5 } }))).toMatch(/whole number/);
    expect(reason(decl({ t: { type: 'number', max: Infinity } }))).toMatch(/must be a number/);
    expect(reason(decl({ t: { type: 'boolean', optional: 'yes' } }))).toMatch(/true or false/);
    expect(
      reason(decl({ t: { type: 'array', of: { type: 'boolean', optional: true }, max: 2 } }))
    ).toMatch(/cannot be optional/);
  });

  it('refuses an action with no input: there is no accept-anything mode', () => {
    expect(reason({ id: 'journal', actions: { a: {} } })).toMatch(/declares no 'input'/);
    expect(reason({ id: 'journal', actions: { a: { input: 'anything' } } })).toMatch(
      /must be a table of fields/
    );
    expect(reason({ id: 'journal', actions: {} })).toMatch(/at least one action/);
  });

  it('refuses a runtime output: it is type-only', () => {
    expect(
      reason({ id: 'journal', actions: { a: { input: {}, output: { '~standard': {} } } } })
    ).toMatch(/type-only/);
  });

  it('refuses bad ids, action names and field names', () => {
    expect(reason({ id: 'Journal', actions: { a: { input: {} } } })).toMatch(/lower_snake_case/);
    expect(reason({ id: 'x'.repeat(33), actions: { a: { input: {} } } })).toMatch(/at most 32/);
    expect(reason({ id: 'ext_journal', actions: { a: { input: {} } } })).toMatch(/reserved/);
    expect(reason({ id: 'journal', actions: { 'a:b': { input: {} } } })).toMatch(
      /not an action name/
    );
    expect(reason({ id: 'journal', actions: { constructor: { input: {} } } })).toMatch(
      /not an action name/
    );
    expect(reason(decl(JSON.parse('{"__proto__":{"type":"boolean"}}')))).toMatch(
      /not a usable field name/
    );
    expect(reason(decl({ toString: { type: 'boolean' } }))).toMatch(/not a usable field name/);
    expect(reason({ id: 'journal', actions: { a: { input: {} } }, format: 2 })).toMatch(
      /reads format 1, not 2/
    );
  });

  it('refuses a declaration that is not a table', () => {
    expect(reason(null)).toMatch(/is a table/);
    expect(reason('journal')).toMatch(/is a table/);
  });
});

describe('the translation to @mica/shared/schema', () => {
  it('parses what the declaration allows and refuses the rest', async () => {
    const input = { title: { type: 'string', min: 1, max: 5 }, n: { type: 'integer', max: 3 } };
    await expect(parse(input, { title: 'hi', n: 2 })).resolves.toEqual({ title: 'hi', n: 2 });
    await expect(parse(input, { title: 'toolong', n: 2 })).rejects.toThrow(
      'title must be 5 characters or fewer.'
    );
    await expect(parse(input, { title: '', n: 2 })).rejects.toThrow('title cannot be empty.');
    await expect(parse(input, { title: 'hi', n: 4 })).rejects.toThrow('n must be 3 or less.');
    await expect(parse(input, { title: 'hi', n: 1.5 })).rejects.toThrow(
      'n must be a whole number.'
    );
    await expect(parse(input, { title: 'hi' })).rejects.toThrow(SchemaError);
  });

  it('refuses a key the declaration does not name', async () => {
    await expect(
      parse({ title: { type: 'string', max: 5 } }, { title: 'a', citizenid: 'X' })
    ).rejects.toThrow('citizenid is not a field this request accepts.');
  });

  it('applies optional, nullable, number, boolean, enum and array', async () => {
    const input = {
      o: { type: 'string', max: 3, optional: true },
      z: { type: 'boolean', nullable: true },
      r: { type: 'number', min: 0, max: 1 },
      e: { type: 'enum', values: ['x', 'y'] },
      a: { type: 'array', of: { type: 'string', max: 2, nullable: true }, max: 2 }
    };
    await expect(parse(input, { z: null, r: 0.5, e: 'y', a: ['ab', null] })).resolves.toEqual({
      z: null,
      r: 0.5,
      e: 'y',
      a: ['ab', null]
    });
    await expect(parse(input, { z: 'true', r: 0.5, e: 'y', a: [] })).rejects.toThrow(
      'z must be true or false.'
    );
    await expect(parse(input, { z: true, r: 2, e: 'y', a: [] })).rejects.toThrow('r must be 1');
    await expect(parse(input, { z: true, r: 0, e: 'w', a: [] })).rejects.toThrow('one of: x, y');
    await expect(parse(input, { z: true, r: 0, e: 'x', a: ['a', 'b', 'c'] })).rejects.toThrow(
      'more than 2 entries'
    );
    await expect(parse(input, { z: true, r: 0, e: 'x', a: ['abc'] })).rejects.toThrow(
      'a[0] must be 2 characters or fewer.'
    );
    await expect(parse(input, { z: true, r: 0, e: 'x', a: [], o: null })).rejects.toThrow(
      'o must be text.'
    );
  });

  it('reads a missing payload as {} — and a required field still refuses it', async () => {
    await expect(parse({}, undefined)).resolves.toEqual({});
    await expect(parse({ o: { type: 'boolean', optional: true } }, null)).resolves.toEqual({});
    await expect(parse({ t: { type: 'boolean' } }, undefined)).rejects.toThrow(
      't must be true or false.'
    );
    await expect(parse({}, 'x')).rejects.toThrow('must be an object.');
    await expect(parse({}, [1])).rejects.toThrow('must be an object.');
  });

  it('builds one validator per action', () => {
    const checked = checkAddonService({
      id: 'journal',
      actions: { a: { input: {} }, b: { input: { t: { type: 'boolean' } } } }
    });
    if (!checked.ok) throw new Error(checked.reason);
    expect(Object.keys(addonActionSchemas(checked.value))).toEqual(['a', 'b']);
  });

  it('shapes a player-facing refusal', () => {
    expect(addonError('Not yours.')).toEqual({ error: { message: 'Not yours.' } });
  });
});
