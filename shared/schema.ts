// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payload schema DSL every service contract is written in.
 *
 * It lives in `shared/` because all three bundles have to read the same declaration: the
 * server validates against it, the client relay reads which actions need preparing, and the
 * web derives the typed call and the mock from it. A validator that only the server can see
 * would be a fourth hand-maintained copy of the same shape.
 *
 * **No runtime dependency** (AGENTS.md §2.5). Zod would be the obvious answer and is also
 * ~14kB of the player's bundle for a job this small: the whole surface here is "does this
 * NUI payload have the fields the handler is about to read, within the bounds the column can
 * hold". Ninety-seven handlers were each answering that by hand, with literal `slice(0, 60)`
 * caps and no rule about what happened to a field nobody remembered to read.
 *
 * ## Every schema is a Standard Schema
 *
 * Each schema carries a `~standard` property implementing Standard Schema v1, and the type a
 * contract accepts is *anything* with one — not this file's own class. That is what lets an
 * add-on bring zod, valibot or arktype for its own service without this repo taking a
 * dependency on any of them, and it is why `parseInput` below validates through
 * `~standard.validate` rather than through `.parse`: `.parse` is zod's spelling and valibot
 * has no such method. `.parse` survives on micaOS-native schemas because it reads better in a
 * test, and it is exactly `parseInput` restricted to this vendor.
 *
 * ## Messages reach players
 *
 * `ServiceEndpoint` forwards a `SchemaError`'s message to the caller as a toast, so every
 * message here is written to be read by a player: it names the field it is about and never a
 * table, a column type, or anything else about the database. That is the same rule
 * `Repository.assertWritableValue` follows, for the same reason.
 */

/**
 * Standard Schema v1, transcribed rather than imported.
 *
 * The published `@standard-schema/spec` package is types-only and would still be a
 * dependency line to justify in three `package.json` files. This is the whole interface;
 * it is versioned by the `version: 1` literal, so a v2 would be a different shape and
 * would fail to assign rather than silently half-work.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  /** Phantom — never present at runtime. Carries the inferred types for `Infer`. */
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** What a contract accepts for an action's `input` or `output`: any Standard Schema v1. */
export type Schema<Output = unknown> = StandardSchemaV1<unknown, Output>;

/**
 * The value a schema yields.
 *
 * Reads the phantom `types` the spec defines, so it works identically on a micaOS schema and
 * on a zod or valibot one an add-on brought — which is the entire reason the contract is
 * typed against `~standard` rather than against `GphoneSchema`.
 */
export type Infer<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];

/** Where in a payload an issue was found. Rendered into the message, never sent structured. */
type Path = readonly (string | number)[];

/**
 * A validation failure, in the one shape `ServiceEndpoint` is allowed to forward verbatim.
 *
 * Distinct from `PlayerFacingError` (`server/lib/errors.ts`) only in provenance: this one was
 * produced by a declaration, that one by a handler that decided a request was refusable. Both
 * are safe to show; anything else is logged with its stack and answered generically.
 */
export class SchemaError extends Error {
  readonly issues: readonly StandardSchemaIssue[];

  constructor(issues: readonly StandardSchemaIssue[]) {
    super(issues[0]?.message ?? 'That request was not in the expected shape.');
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

/** How a field is named to a player. Bare `label`, or `tags[2]`, or `page.limit`. */
const describe = (path: Path): string => {
  if (path.length === 0) return 'That value';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
};

type Outcome<T> = { ok: true; value: T } | { ok: false; issues: StandardSchemaIssue[] };

const fail = (path: Path, message: string): Outcome<never> => ({
  ok: false,
  issues: [{ message: `${describe(path)} ${message}`, path: [...path] }]
});

/** A micaOS-native schema. Structural, so `s.string()` and `s.object({...})` are the same type. */
export interface GphoneSchema<T> extends StandardSchemaV1<unknown, T> {
  /**
   * Validate, or throw a `SchemaError`. The sync half of `parseInput`, kept because a test
   * reading `expect(() => schema.parse(x)).toThrow()` is clearer than an awaited helper.
   */
  parse(input: unknown): T;
  /** Accept `undefined` as well. On an object field, this also makes the key optional. */
  optional(): GphoneSchema<T | undefined>;
  /** Accept `null` as well. Distinct from `optional` — a JSON null is a value, not an absence. */
  nullable(): GphoneSchema<T | null>;
}

/**
 * Every micaOS schema's raw checker, which takes the path it is being checked at.
 *
 * A composite has to hand its children the path they live at, or the message a player reads
 * says "That value must be 255 characters or fewer" instead of naming `label`. The Standard
 * Schema `validate` signature takes no path — correctly, since it is the *outermost* call —
 * so nesting goes through this instead, and only a foreign schema falls back to `validate`.
 *
 * A WeakMap rather than a property so it stays off the object a contract exports: the schema
 * a service declares is read by three bundles, and an internal function hanging off it is an
 * invitation for one of them to call it.
 */
const checkers = new WeakMap<object, (value: unknown, path: Path) => Outcome<unknown>>();

const make = <T>(check: (value: unknown, path: Path) => Outcome<T>): GphoneSchema<T> => {
  const schema: GphoneSchema<T> = {
    '~standard': {
      version: 1,
      vendor: 'mica',
      validate: (value: unknown) => {
        const outcome = check(value, []);
        return outcome.ok ? { value: outcome.value } : { issues: outcome.issues };
      }
    },
    parse(input: unknown): T {
      const outcome = check(input, []);
      if (!outcome.ok) throw new SchemaError(outcome.issues);
      return outcome.value;
    },
    optional: () =>
      make<T | undefined>((value, path) =>
        value === undefined ? { ok: true, value: undefined } : check(value, path)
      ),
    nullable: () =>
      make<T | null>((value, path) =>
        value === null ? { ok: true, value: null } : check(value, path)
      )
  };
  checkers.set(schema, check as (value: unknown, path: Path) => Outcome<unknown>);
  return schema;
};

/** The checker behind any schema, native or foreign, bound to the path it sits at. */
const checkerOf =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (value: unknown, path: Path): Outcome<T> => {
    const native = checkers.get(schema);
    if (native) return native(value, path) as Outcome<T>;

    const result = schema['~standard'].validate(value);
    if (result instanceof Promise) {
      // A composite cannot await inside a sync `parse`. Reachable only for a foreign schema
      // nested in a micaOS one, which no contract does today — and a loud refusal beats a
      // pending promise silently reaching SQL as `[object Promise]`.
      return fail(path, 'could not be checked synchronously.');
    }
    if (result.issues) {
      return {
        ok: false,
        issues: result.issues.map((issue) => {
          const inner = (issue.path ?? []).map((segment) =>
            typeof segment === 'object' ? segment.key : segment
          );
          const full = [...path, ...(inner as (string | number)[])];
          // A foreign vendor wrote its own sentence and has no idea where in our payload it
          // sits, so the field name is prepended rather than the message rewritten.
          return { message: `${describe(full)}: ${issue.message}`, path: full };
        })
      };
    }
    return { ok: true, value: result.value };
  };

export interface StringOptions {
  /** Minimum length in characters. A `min: 1` is how "not blank" is spelled. */
  min?: number;
  /** Maximum length in characters. Match the column's declared length. */
  max?: number;
  /** Shape the value must match. Anchor it — an unanchored pattern matches a substring. */
  pattern?: RegExp;
}

export interface NumberOptions {
  min?: number;
  max?: number;
}

export interface ArrayOptions {
  min?: number;
  /** Maximum element count. Every array schema should set one — an unbounded list is a flood. */
  max?: number;
}

/**
 * A number, or a string spelling one.
 *
 * The string half is not laxity: `fetchNui` payloads carry ids that have been through a
 * `<select>` or a route param more than once, and `requirePositiveInt` accepted both since
 * the beginning. What it refuses is everything else, up front and by `typeof` — because
 * `Number([7])` is `7`, so a bare coercion quietly accepts `{ id: [7] }` from a client, and
 * `Number(true)` is `1`, and `Number('')` and `Number('  ')` are both `0`. Each of those is a
 * value the client did not send, invented by the coercion.
 */
const toNumber = (value: unknown, path: Path): Outcome<number> => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail(path, 'must be a number.');
    return { ok: true, value };
  }
  if (typeof value !== 'string' || value.trim() === '') return fail(path, 'must be a number.');
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fail(path, 'must be a number.');
  return { ok: true, value: parsed };
};

const bounded = (value: number, path: Path, options: NumberOptions): Outcome<number> => {
  if (options.min !== undefined && value < options.min) {
    return fail(path, `must be ${options.min} or more.`);
  }
  if (options.max !== undefined && value > options.max) {
    return fail(path, `must be ${options.max} or less.`);
  }
  return { ok: true, value };
};

type ObjectShape = Record<string, StandardSchemaV1<unknown, unknown>>;

type OptionalKeys<S extends ObjectShape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];

/**
 * The object an `s.object({...})` yields.
 *
 * A field whose schema accepts `undefined` becomes an optional *property*, not a required one
 * typed `T | undefined` — otherwise every handler would have to write `body.label!` or a
 * redundant guard, and the type would stop being worth having.
 */
export type ObjectOutput<S extends ObjectShape> = {
  [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

export const s = {
  string(options: StringOptions = {}): GphoneSchema<string> {
    return make<string>((value, path) => {
      if (typeof value !== 'string') return fail(path, 'must be text.');
      if (options.min !== undefined && value.length < options.min) {
        return options.min === 1
          ? fail(path, 'cannot be empty.')
          : fail(path, `must be at least ${options.min} characters.`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return fail(path, `must be ${options.max} characters or fewer.`);
      }
      if (options.pattern && !options.pattern.test(value)) {
        return fail(path, 'is not in the expected format.');
      }
      return { ok: true, value };
    });
  },

  int(options: NumberOptions = {}): GphoneSchema<number> {
    return make<number>((value, path) => {
      const numeric = toNumber(value, path);
      if (!numeric.ok) return numeric;
      if (!Number.isInteger(numeric.value)) return fail(path, 'must be a whole number.');
      return bounded(numeric.value, path, options);
    });
  },

  /** A row id, a count, a page size. The shape `requirePositiveInt` guarded by hand. */
  positiveInt(options: NumberOptions = {}): GphoneSchema<number> {
    return s.int({ min: 1, ...options });
  },

  number(options: NumberOptions = {}): GphoneSchema<number> {
    return make<number>((value, path) => {
      const numeric = toNumber(value, path);
      if (!numeric.ok) return numeric;
      return bounded(numeric.value, path, options);
    });
  },

  /** Strict. A payload saying `'true'` is a client that meant something else. */
  boolean(): GphoneSchema<boolean> {
    return make<boolean>((value, path) =>
      typeof value === 'boolean' ? { ok: true, value } : fail(path, 'must be true or false.')
    );
  },

  enum<const V extends readonly [string, ...string[]]>(values: V): GphoneSchema<V[number]> {
    return make<V[number]>((value, path) => {
      if (typeof value !== 'string' || !values.includes(value)) {
        return fail(path, `must be one of: ${values.join(', ')}.`);
      }
      return { ok: true, value: value as V[number] };
    });
  },

  array<S extends StandardSchemaV1<unknown, unknown>>(
    item: S,
    options: ArrayOptions = {}
  ): GphoneSchema<Infer<S>[]> {
    const checkItem = checkerOf(item);
    return make<Infer<S>[]>((value, path) => {
      if (!Array.isArray(value)) return fail(path, 'must be a list.');
      if (options.min !== undefined && value.length < options.min) {
        return fail(path, `needs at least ${options.min} entries.`);
      }
      // Length before contents: refusing a million-element array should not first cost a
      // million checks, which is the flood paying for itself.
      if (options.max !== undefined && value.length > options.max) {
        return fail(path, `cannot have more than ${options.max} entries.`);
      }
      const out: Infer<S>[] = [];
      for (let index = 0; index < value.length; index++) {
        const outcome = checkItem(value[index], [...path, index]);
        if (!outcome.ok) return outcome;
        out.push(outcome.value as Infer<S>);
      }
      return { ok: true, value: out };
    });
  },

  /**
   * A strict object: a key the shape does not declare is refused, not dropped.
   *
   * Refused rather than silently stripped because the point is that a hostile key has no
   * slot. Stripping would be safe for SQL and would still let a client believe it had set
   * something it had not — and it would hide the real case this catches, which is the UI and
   * the server disagreeing about a field name. `ServiceEndpoint.pickColumns` still reduces
   * the *generic CRUD* payload by allowlist; this is the custom-action half of the same rule.
   */
  object<S extends ObjectShape>(shape: S): GphoneSchema<ObjectOutput<S>> {
    const entries = Object.entries(shape).map(([key, schema]) => [key, checkerOf(schema)] as const);
    const declared = new Set(Object.keys(shape));
    return make<ObjectOutput<S>>((value, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(path, 'must be an object.');
      }
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!declared.has(key)) {
          return fail([...path, key], 'is not a field this request accepts.');
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, check] of entries) {
        // `in` rather than `!== undefined`: an explicitly-sent `null` must still reach the
        // field's own schema, which is the only thing that knows whether null is allowed.
        const outcome = check(key in input ? input[key] : undefined, [...path, key]);
        if (!outcome.ok) return outcome;
        if (outcome.value !== undefined || key in input) out[key] = outcome.value;
      }
      return { ok: true, value: out as ObjectOutput<S> };
    });
  },

  /**
   * A value this layer deliberately does not describe.
   *
   * One use, and it should stay that way: a settings value, which is app-owned JSON the OS
   * has no business having an opinion about. Everything reachable from a `s.unknown()` is
   * back to being hand-checked, so reach for a real shape first.
   */
  unknown(): GphoneSchema<unknown> {
    return make<unknown>((value) => ({ ok: true, value }));
  },

  /**
   * An action that takes no payload.
   *
   * Accepts `undefined`, `null` and `{}` — the three things the relay can produce for a call
   * with no arguments, depending on how far down the stack the absence started — and yields
   * `undefined`. Anything else is refused, so `capabilities` growing a payload is a decision
   * somebody makes rather than something a client asserts.
   */
  none(): GphoneSchema<undefined> {
    return make<undefined>((value, path) => {
      if (value === undefined || value === null) return { ok: true, value: undefined };
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
        return { ok: true, value: undefined };
      }
      return fail(path, 'takes no payload.');
    });
  }
};

/**
 * Validate a value against any Standard Schema, or throw a `SchemaError`.
 *
 * Async because the spec allows an async `validate` and a foreign schema may use one. Every
 * micaOS schema resolves synchronously, so the await costs a microtask on the server's hot
 * path and buys an add-on the right to bring whatever validator it already uses.
 */
export async function parseInput<S extends StandardSchemaV1>(
  schema: S,
  value: unknown
): Promise<Infer<S>> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) throw new SchemaError(result.issues);
  return result.value as Infer<S>;
}

/** Whether a value is a Standard Schema v1, which is the only thing a contract accepts. */
export function isSchema(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== 'object') return false;
  const props = (value as { '~standard'?: unknown })['~standard'];
  return (
    !!props &&
    typeof props === 'object' &&
    (props as { version?: unknown }).version === 1 &&
    typeof (props as { validate?: unknown }).validate === 'function'
  );
}
