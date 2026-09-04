// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { s, SchemaError, parseInput, isSchema, type Infer } from './schema';

/**
 * What the DSL has to get right, and why each case is here.
 *
 * These are not shape tests for their own sake. Every one of them is a coercion or an
 * omission that a hand-written handler got wrong at least once, or that `server/lib/payload.ts`
 * had to write a paragraph of comment to defend. The DSL replaces ninety-seven copies of that
 * reasoning, so it is the thing that now has to hold it.
 */

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a throw');
};

describe('strings', () => {
  it('takes text and refuses everything else', () => {
    expect(s.string().parse('hello')).toBe('hello');
    for (const bad of [1, true, null, undefined, {}, ['a']]) {
      expect(() => s.string().parse(bad)).toThrow(SchemaError);
    }
  });

  it('bounds length at both ends', () => {
    expect(() => s.string({ min: 1 }).parse('')).toThrow(SchemaError);
    expect(() => s.string({ max: 3 }).parse('abcd')).toThrow(SchemaError);
    expect(s.string({ min: 1, max: 3 }).parse('abc')).toBe('abc');
  });

  it('checks a pattern', () => {
    const handle = s.string({ pattern: /^[a-z0-9_]{1,20}$/ });
    expect(handle.parse('quiss_01')).toBe('quiss_01');
    expect(() => handle.parse('Not A Handle')).toThrow(SchemaError);
  });

  /**
   * The cap is enforced, not applied.
   *
   * `Blabber.ts` wrote `slice(0, 60)` and `Media.ts` wrote `slice(0, 255)`, so an
   * over-long value was silently truncated and the client was told the write succeeded with
   * the value it sent. Same failure MySQL's non-strict mode produces, reimplemented by hand.
   */
  it('refuses an over-long value rather than truncating it', () => {
    expect(() => s.string({ max: 60 }).parse('x'.repeat(61))).toThrow(SchemaError);
  });
});

describe('numbers', () => {
  it('accepts a number or a string spelling one', () => {
    expect(s.int().parse(7)).toBe(7);
    expect(s.int().parse('7')).toBe(7);
    expect(s.number().parse('1.5')).toBe(1.5);
  });

  /**
   * `requirePositiveInt`'s whole reason for existing, moved here intact.
   *
   * `Number([7])` is `7`, so a bare `Number()` coercion accepts `{ id: [7] }` from a client
   * and hands SQL a value the payload never contained. `Number(true)` is `1`, `Number(null)`
   * is `0`, and `Number('')` and `Number('  ')` are both `0` — each of them a value invented
   * by the coercion rather than sent. Every one is refused by `typeof` before any coercion
   * runs.
   */
  it('refuses anything a bare Number() coercion would invent a value for', () => {
    for (const bad of [[7], [], {}, true, false, null, '', '   ', 'seven', NaN, Infinity]) {
      expect(() => s.int().parse(bad), String(bad)).toThrow(SchemaError);
    }
  });

  it('requires a whole number for int and allows a fraction for number', () => {
    expect(() => s.int().parse(1.5)).toThrow(SchemaError);
    expect(s.number().parse(1.5)).toBe(1.5);
  });

  it('bounds a range', () => {
    expect(() => s.int({ min: 0, max: 100 }).parse(101)).toThrow(SchemaError);
    expect(() => s.int({ min: 0, max: 100 }).parse(-1)).toThrow(SchemaError);
    expect(s.int({ min: 0, max: 100 }).parse(100)).toBe(100);
  });

  it('positiveInt is int with a floor of one', () => {
    expect(s.positiveInt().parse(1)).toBe(1);
    for (const bad of [0, -1, 0.5, '0']) {
      expect(() => s.positiveInt().parse(bad), String(bad)).toThrow(SchemaError);
    }
  });
});

describe('booleans and enums', () => {
  it('does not coerce a boolean', () => {
    expect(s.boolean().parse(false)).toBe(false);
    for (const bad of [0, 1, 'true', 'false', null]) {
      expect(() => s.boolean().parse(bad), String(bad)).toThrow(SchemaError);
    }
  });

  it('accepts only a declared enum member', () => {
    const action = s.enum(['dismiss', 'moderate']);
    expect(action.parse('moderate')).toBe('moderate');
    expect(() => action.parse('delete')).toThrow(SchemaError);
    // The list is in the message so a player can act on it, and it names no table.
    expect(message(() => action.parse('delete'))).toContain('dismiss, moderate');
  });
});

describe('arrays', () => {
  it('bounds the element count', () => {
    const tags = s.array(s.string({ max: 32 }), { max: 3 });
    expect(tags.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => tags.parse(['a', 'b', 'c', 'd'])).toThrow(SchemaError);
  });

  it('checks every element and names the index that failed', () => {
    const ids = s.array(s.positiveInt(), { max: 10 });
    expect(message(() => ids.parse([1, 2, 'nope']))).toContain('[2]');
  });

  it('refuses a non-array', () => {
    for (const bad of [{ 0: 'a' }, 'ab', 3, null]) {
      expect(() => s.array(s.string(), { max: 4 }).parse(bad), String(bad)).toThrow(SchemaError);
    }
  });
});

describe('objects are strict', () => {
  const body = s.object({
    id: s.positiveInt(),
    label: s.string({ max: 255 }).optional()
  });

  it('accepts a declared shape', () => {
    expect(body.parse({ id: 4, label: 'Alta St' })).toEqual({ id: 4, label: 'Alta St' });
    expect(body.parse({ id: 4 })).toEqual({ id: 4 });
  });

  /**
   * The point of strictness. A hostile key does not get inspected, coerced or stored — it has
   * no slot, and the request that carried it is refused rather than half-honoured. This is the
   * custom-action half of what `ServiceEndpoint.pickColumns` does for generic CRUD.
   */
  it('refuses a key it does not declare', () => {
    expect(() => body.parse({ id: 4, citizenid: 'ABC123' })).toThrow(SchemaError);
    expect(message(() => body.parse({ id: 4, status: 'moderated' }))).toContain('status');
  });

  it('refuses a payload that is not an object', () => {
    for (const bad of [4, 'four', null, undefined, [4]]) {
      expect(() => body.parse(bad), String(bad)).toThrow(SchemaError);
    }
  });

  it('names the nested field a player has to fix', () => {
    const page = s.object({ page: s.object({ limit: s.positiveInt() }) });
    expect(message(() => page.parse({ page: { limit: 0 } }))).toContain('page.limit');
  });

  it('omits an absent optional key rather than setting it undefined', () => {
    expect(Object.keys(body.parse({ id: 4 }))).toEqual(['id']);
  });
});

describe('optional and nullable are different questions', () => {
  it('optional accepts absence, not null', () => {
    const schema = s.string().optional();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(() => schema.parse(null)).toThrow(SchemaError);
  });

  it('nullable accepts null, not absence', () => {
    const schema = s.string().nullable();
    expect(schema.parse(null)).toBeNull();
    expect(() => schema.parse(undefined)).toThrow(SchemaError);
  });

  it('composes both for a cursor, which is genuinely three-valued', () => {
    const cursor = s.positiveInt().nullable().optional();
    expect(cursor.parse(undefined)).toBeUndefined();
    expect(cursor.parse(null)).toBeNull();
    expect(cursor.parse(12)).toBe(12);
    expect(() => cursor.parse(0)).toThrow(SchemaError);
  });
});

describe('an action that takes no payload', () => {
  it('accepts the three shapes an empty call can arrive as', () => {
    expect(s.none().parse(undefined)).toBeUndefined();
    expect(s.none().parse(null)).toBeUndefined();
    expect(s.none().parse({})).toBeUndefined();
  });

  it('refuses a payload, so growing one is a decision', () => {
    expect(() => s.none().parse({ limit: 10 })).toThrow(SchemaError);
    expect(() => s.none().parse('x')).toThrow(SchemaError);
  });
});

describe('messages are safe to show a player', () => {
  const contact = s.object({
    number: s.string({ min: 1, max: 20 }),
    favorite: s.boolean().optional()
  });

  it('names the field and nothing about the database', () => {
    const text = message(() => contact.parse({ number: 'x'.repeat(21) }));
    expect(text).toContain('number');
    expect(text).not.toMatch(/mica_|table|column|SELECT|INSERT|varchar/i);
  });

  it('carries every issue on the error, with the failing path', () => {
    try {
      contact.parse({ number: '555', favorite: 'yes' });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).issues[0]?.path).toEqual(['favorite']);
    }
  });
});

describe('Standard Schema v1', () => {
  it('every schema carries a v1 ~standard', () => {
    for (const schema of [s.string(), s.int(), s.object({}), s.array(s.int(), { max: 1 })]) {
      expect(schema['~standard'].version).toBe(1);
      expect(schema['~standard'].vendor).toBe('mica');
      expect(isSchema(schema)).toBe(true);
    }
  });

  it('validate answers with a value or with issues, never by throwing', () => {
    expect(s.int()['~standard'].validate(5)).toEqual({ value: 5 });
    const bad = s.int()['~standard'].validate('x') as { issues: { message: string }[] };
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]?.message).toContain('number');
  });

  /**
   * The reason the contract is typed against `~standard` and not against this file's own
   * schema type: an add-on may bring zod, valibot or arktype for its own service, and the
   * server has to validate through it without knowing which. This stands in for one.
   */
  it('parseInput accepts a foreign vendor', () => {
    const foreign = {
      '~standard': {
        version: 1 as const,
        vendor: 'somebody-else',
        validate: (value: unknown) =>
          typeof value === 'string' ? { value } : { issues: [{ message: 'not a string' }] }
      }
    };
    expect(isSchema(foreign)).toBe(true);
    return Promise.all([
      expect(parseInput(foreign, 'ok')).resolves.toBe('ok'),
      expect(parseInput(foreign, 3)).rejects.toBeInstanceOf(SchemaError)
    ]);
  });

  it('parseInput awaits an async vendor', async () => {
    const async = {
      '~standard': {
        version: 1 as const,
        vendor: 'async-vendor',
        validate: async (value: unknown) => ({ value: value as number })
      }
    };
    await expect(parseInput(async, 9)).resolves.toBe(9);
  });

  it('prefixes a nested foreign message with the field it sits at', async () => {
    const foreign = {
      '~standard': {
        version: 1 as const,
        vendor: 'somebody-else',
        validate: (_value: unknown) => ({ issues: [{ message: 'not a string' }] })
      }
    };
    const wrapped = s.object({ note: foreign });
    await expect(parseInput(wrapped, { note: 1 })).rejects.toThrow(/note: not a string/);
  });

  it('rejects a v2 or a non-schema', () => {
    expect(isSchema({ '~standard': { version: 2, validate: () => ({}) } })).toBe(false);
    expect(isSchema({})).toBe(false);
    expect(isSchema(null)).toBe(false);
  });
});

describe('inferred types', () => {
  it('makes an optional field an optional property', () => {
    const schema = s.object({
      id: s.positiveInt(),
      label: s.string().optional(),
      tags: s.array(s.string(), { max: 4 })
    });
    type Body = Infer<typeof schema>;

    // Compile-time assertions: the objects below only typecheck if `label` is optional and
    // the other two are not. `pnpm test:unit:web` runs this file through the same TypeScript
    // the web is checked with, so a regression here is a red suite rather than a silent
    // widening to `any`.
    const complete: Body = { id: 1, label: 'x', tags: [] };
    const minimal: Body = { id: 1, tags: ['a'] };
    expect(schema.parse(complete)).toEqual(complete);
    expect(schema.parse(minimal)).toEqual(minimal);
  });
});
