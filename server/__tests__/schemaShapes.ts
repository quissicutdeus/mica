// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { s as schemaBuilders, StandardSchemaV1 } from '@mica/shared/schema';

/**
 * What a contract's input schema declares, read back out of the declaration (MICA-463).
 *
 * A micaOS schema is a closure: `s.object({ label: s.string({ max: 64 }) })` keeps its shape in
 * a module-private `WeakMap` and exposes only `validate`. A sweep that sends every action a
 * wrong type for each declared field, or a string one past each declared width, needs that
 * shape — and a hand-kept list of fields per action is exactly the thing a new action's author
 * forgets to extend.
 *
 * So `recordSchemaShapes` wraps the builders on `s` **in place**, before any contract is
 * imported, to note what each call was asked for beside the schema it returns. The schema is the
 * builder's own object, unchanged: the `WeakMap` inside `shared/schema.ts` is keyed on that
 * object, so nesting, paths and messages all behave exactly as they do in production. Only the
 * three chaining methods are replaced on each returned object, so that `.optional()`,
 * `.nullable()` and `.transform()` hand back a schema whose shape is known too.
 *
 * Anything this cannot describe — a foreign Standard Schema an add-on brought, or a contract
 * evaluated before the recorder was installed — has no shape, and the sweep lists it as
 * uncovered rather than skipping it.
 */

export type Shape =
  | { kind: 'string'; min?: number; max?: number; pattern?: RegExp; truncate?: number }
  | { kind: 'int' | 'number'; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; item: StandardSchemaV1; min?: number; max?: number }
  | { kind: 'object'; shape: Record<string, StandardSchemaV1>; strip: boolean }
  | { kind: 'tuple'; elements: readonly StandardSchemaV1[] }
  | { kind: 'union'; members: readonly StandardSchemaV1[] }
  | { kind: 'unknown' }
  | { kind: 'none' };

export type Described = Shape & { optional?: true; nullable?: true; transformed?: true };

const shapes = new WeakMap<object, Described>();
let installed = false;

type Chainable = {
  optional: () => unknown;
  nullable: () => unknown;
  transform: (fn: (value: never) => unknown) => unknown;
};

const tag = <T>(schema: T, described: Described): T => {
  const chain = schema as unknown as Chainable;
  const optional = chain.optional.bind(chain);
  const nullable = chain.nullable.bind(chain);
  const transform = chain.transform.bind(chain);
  shapes.set(schema as object, described);
  chain.optional = () => tag(optional(), { ...described, optional: true });
  chain.nullable = () => tag(nullable(), { ...described, nullable: true });
  chain.transform = (fn) => tag(transform(fn), { ...described, transformed: true });
  return schema;
};

/**
 * Wrap every builder on `s` so the schemas it makes can be described. Idempotent. Must run before
 * the contracts are imported, which is why the sweep imports its services dynamically.
 */
export function recordSchemaShapes(s: typeof schemaBuilders): void {
  if (installed) return;
  installed = true;
  const builders = s as unknown as Record<string, (...args: never[]) => unknown>;
  const wrap = (name: string, describe: (args: unknown[]) => Shape): void => {
    const original = builders[name]!.bind(s);
    builders[name] = (...args: never[]) => tag(original(...args), describe(args));
  };
  type Opts = Record<string, unknown> | undefined;
  const opts = (args: unknown[]): NonNullable<Opts> => (args[0] as Opts) ?? {};

  wrap('string', (args) => ({ kind: 'string', ...opts(args) }));
  wrap('int', (args) => ({ kind: 'int', ...opts(args) }));
  // `positiveInt` calls `s.int` through the same object, so it is tagged twice; the outer tag is
  // the one that sticks and says the same thing with the floor written in.
  wrap('positiveInt', (args) => ({ kind: 'int', min: 1, ...opts(args) }));
  wrap('number', (args) => ({ kind: 'number', ...opts(args) }));
  wrap('boolean', () => ({ kind: 'boolean' }));
  wrap('literal', (args) => ({ kind: 'literal', value: args[0] as string | number | boolean }));
  wrap('enum', (args) => ({ kind: 'enum', values: args[0] as readonly string[] }));
  wrap('array', (args) => ({
    kind: 'array',
    item: args[0] as StandardSchemaV1,
    ...(args[1] as Opts)
  }));
  wrap('object', (args) => ({
    kind: 'object',
    shape: args[0] as Record<string, StandardSchemaV1>,
    strip: ((args[1] as Opts)?.unknownKeys ?? 'refuse') === 'strip'
  }));
  wrap('tuple', (args) => ({ kind: 'tuple', elements: args[0] as readonly StandardSchemaV1[] }));
  wrap('union', (args) => ({ kind: 'union', members: args[0] as readonly StandardSchemaV1[] }));
  wrap('unknown', () => ({ kind: 'unknown' }));
  wrap('none', () => ({ kind: 'none' }));
}

/** What a schema was declared as, or undefined when it was not built by a recorded `s`. */
export const shapeOf = (schema: unknown): Described | undefined =>
  schema && typeof schema === 'object' ? shapes.get(schema) : undefined;

/**
 * Text tried against a declared `pattern`, first match wins. Not a generator: a pattern none of
 * these fit leaves its action on the sweep's pinned uncovered list, which is where a new shape of
 * identifier should be noticed.
 */
const PATTERN_CANDIDATES = [
  '1234',
  '555-0100',
  'en',
  'ABCDEFGHJKMNPQRS',
  'data:image/png;base64,AAAA',
  'https://example.com/a.png',
  '0123456789abcdef0123456789abcdef'
];

export type Synthesized = { ok: true; value: unknown } | { ok: false; why: string };

/**
 * One value the schema accepts, built from its description alone — the baseline every per-field
 * case varies one field of. An optional object field is left out. Refuses, with the reason,
 * where nothing can be built honestly: a `pattern` (no generator for a regular expression), or
 * a schema with no description.
 */
export function synthesize(schema: unknown): Synthesized {
  const shape = shapeOf(schema);
  if (!shape) return { ok: false, why: 'no recorded shape' };
  switch (shape.kind) {
    case 'string': {
      const fits = (value: string): boolean =>
        value.length >= (shape.min ?? 0) &&
        (shape.max === undefined || value.length <= shape.max) &&
        (!shape.pattern || shape.pattern.test(value));
      const value = ['a'.repeat(Math.max(shape.min ?? 0, 1)), ...PATTERN_CANDIDATES].find(fits);
      return value !== undefined
        ? { ok: true, value }
        : { ok: false, why: `nothing built fits ${String(shape.pattern ?? 'its bounds')}` };
    }
    case 'int':
    case 'number': {
      const value = Math.max(shape.min ?? 1, 1);
      return { ok: true, value: shape.max !== undefined ? Math.min(value, shape.max) : value };
    }
    case 'boolean':
      return { ok: true, value: true };
    case 'literal':
      return { ok: true, value: shape.value };
    case 'enum':
      return { ok: true, value: shape.values[0] };
    case 'array': {
      const count = shape.min ?? 0;
      if (count === 0) return { ok: true, value: [] };
      const item = synthesize(shape.item);
      return item.ok ? { ok: true, value: Array.from({ length: count }, () => item.value) } : item;
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape.shape)) {
        if (shapeOf(field)?.optional) continue;
        const value = synthesize(field);
        if (!value.ok) return { ok: false, why: `${key}: ${value.why}` };
        out[key] = value.value;
      }
      return { ok: true, value: out };
    }
    case 'tuple': {
      const out: unknown[] = [];
      for (const element of shape.elements) {
        const value = synthesize(element);
        if (!value.ok) return value;
        out.push(value.value);
      }
      return { ok: true, value: out };
    }
    case 'union': {
      for (const member of shape.members) {
        const value = synthesize(member);
        if (value.ok) return value;
      }
      return { ok: false, why: 'no union member could be built' };
    }
    case 'unknown':
      return { ok: true, value: 'x' };
    case 'none':
      return { ok: true, value: undefined };
  }
}

/**
 * Values of the wrong type for a field of this shape — each one something a client can put on
 * the wire and the field's declaration does not admit. Never derived from what the schema
 * happens to accept: a `null` is offered unless the field was declared `nullable`, and a numeric
 * string is not offered to an `int`, because `s.int` documents accepting one.
 */
export function wrongTypes(shape: Described): { label: string; value: unknown }[] {
  const all: { label: string; value: unknown }[] = [
    { label: 'a number', value: 42 },
    { label: 'a boolean', value: true },
    { label: 'text', value: 'not-the-right-type' },
    { label: 'an object', value: { nested: 1 } },
    { label: 'a list', value: [1, 2] },
    { label: 'null', value: null }
  ];
  // `s.unknown()` admits every value, so it has no wrong type; the sweep lists the field instead.
  // A union or tuple is not varied member by member either; the sweep lists each such field.
  if (['unknown', 'none', 'union', 'tuple'].includes(shape.kind)) return [];
  const keep = (label: string): boolean => {
    if (label === 'null') return !shape.nullable;
    switch (shape.kind) {
      case 'string':
        return label !== 'text';
      case 'int':
      case 'number':
        return label !== 'a number';
      case 'boolean':
        return label !== 'a boolean';
      case 'enum':
      case 'literal':
        // Text that is not a member is the wrong value of the right type, and still refused.
        return true;
      case 'array':
        return label !== 'a list';
      case 'object':
        return label !== 'an object';
      default:
        return false;
    }
  };
  return all.filter(({ label }) => keep(label));
}

/**
 * A declared field the server sweep sends no wrong type to, because its declaration admits every
 * value. `field` is the path inside the payload, as `shared/schema.ts` names it to a player.
 */
export interface NotVariedField {
  event: string;
  field: string;
  kind: Described['kind'];
  why: string;
}

/** A raw handler's positional argument the server sweep does not vary, by its index. */
export interface NotVariedArgument {
  event: string;
  arg: number;
  kind: Described['kind'];
  why: string;
}

// Pinned exactly by hostilePayloads.test.ts; imported by client/__tests__/hostileNuiPayloads.test.ts.
export const FIELDS_WITHOUT_A_WRONG_TYPE: readonly NotVariedField[] = [
  {
    event: 'mica:server:settings:set',
    field: 'value',
    kind: 'unknown',
    why: "app-owned JSON the OS has no opinion about (shared/schema.ts `s.unknown`'s one use)"
  }
];

// Pinned exactly by hostilePayloads.test.ts; imported by client/__tests__/hostileNuiPayloads.test.ts.
export const RAW_ARGUMENTS_NOT_VARIED: readonly NotVariedArgument[] = [
  {
    event: 'mica:server:shell:setOpen',
    arg: 0,
    kind: 'union',
    why: 'a bare boolean or `{ device, open }` (MICA-262); a union is not varied member by member'
  }
];
