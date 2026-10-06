// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { s, type GphoneSchema, type StandardSchemaResult, type StandardSchemaV1 } from './schema';

/**
 * An add-on's server half, declared once and read by both ends (MICA-308).
 *
 * A Store add-on reaches its service through `useService(id)`, and since MICA-308 the service
 * behind that id can live in the add-on's **own** FiveM resource: it calls
 * `exports.mica:RegisterService(declaration, handlers)` and micaOS answers
 * `mica:server:<id>:<action>` for it, through the same guard every core service sits behind
 * (AGENTS.md §2.9). This file is the declaration both of them read: the server parses every
 * payload against it before a handler runs, and the add-on's UI derives its typed calls from
 * the same object.
 *
 * ```ts
 * export const journal = defineAddonService({
 *   id: 'journal',
 *   actions: {
 *     create: { input: { title: { type: 'string', max: 80 }, body: { type: 'string', max: 2000, optional: true } } },
 *     list: { input: {}, output: addonOutput<Entry[]>() }
 *   }
 * });
 * ```
 *
 * **Plain data, on purpose.** A Lua resource writes the same table (`{ title = { type =
 * 'string', max = 80 } }`) and a JS resource passes the object straight through the export,
 * so nothing in a declaration may be a function, a class or a `RegExp` — which is why this is
 * a small table form over `@mica/shared/schema` rather than `s.object(...)` itself: a schema
 * built from `s` carries functions, and a function does not survive an export boundary as
 * anything but a reference into the other resource.
 *
 * **Strict.** An unknown key, an unknown kind, a `string` without `max`, an `array` without
 * `max` or an empty `enum` is refused with the reason, never ignored: a bound the author
 * misspelt is a bound that does not exist, and every value here reaches the add-on's own SQL.
 *
 * **No nested objects** in format 1. A field is a primitive or an array of primitives. An
 * action that needs structure takes several fields, or a string it parses itself.
 *
 * **What it does not prove.** `input` is validated; ownership is not. micaOS hands the
 * handler the caller's `citizenid` — the one identity it vouches for — and whether that
 * citizen may touch the row an input names is the add-on's own check to write.
 */

/** Bumped when a declaration that parses today would mean something else. Not on additions. */
export const ADDON_SERVICE_FORMAT_VERSION = 1;

/**
 * The bounds a declaration itself must keep. Each is a ceiling on what an author may *declare*,
 * not a default: a `string` still needs its own `max`, and that `max` may be no larger than
 * `stringMax`.
 */
export const ADDON_SERVICE_LIMITS = {
  /** An id is the `<service>` event segment and an app id, and `mica_notifications.app` is 32. */
  idLength: 32,
  /** An action name is the `<action>` event segment. */
  actionLength: 32,
  actions: 64,
  fieldLength: 64,
  fieldsPerAction: 64,
  /** The largest `max` a `string` may declare. */
  stringMax: 65_535,
  /** The largest `max` an `array` may declare. */
  arrayMax: 1_000,
  enumValues: 64,
  enumValueLength: 64
} as const;

/** The `<service>` segment: lower_snake_case, the same rule every app id and event uses. */
export const ADDON_SERVICE_ID = /^[a-z][a-z0-9_]*$/;
/** The `<action>` segment. Camel case is allowed, as `shared/rpc.ts`'s generic door allows it. */
export const ADDON_ACTION_NAME = /^[a-z][a-zA-Z0-9_]*$/;
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Reserved for `SendNotification`'s external groups (`ext_<resource>`). `defineApp` refuses an
 * app id with it, so an add-on can never have one either.
 */
const EXTERNAL_PREFIX = 'ext_';

interface FieldCommon {
  /** The key may be absent. On an array's `of`, refused: a JSON list has no absent entries. */
  optional?: boolean;
  /** `null` is accepted as a value. Distinct from `optional`, as in `@mica/shared/schema`. */
  nullable?: boolean;
}

export interface StringField extends FieldCommon {
  type: 'string';
  /** At least this many characters. `min = 1` is how "not empty" is spelled. */
  min?: number;
  /** Required: an unbounded string is a flood, and it is going into somebody's column. */
  max: number;
}

export interface IntegerField extends FieldCommon {
  type: 'integer';
  min?: number;
  max?: number;
}

export interface NumberField extends FieldCommon {
  type: 'number';
  min?: number;
  max?: number;
}

export interface BooleanField extends FieldCommon {
  type: 'boolean';
}

export interface EnumField extends FieldCommon {
  type: 'enum';
  /** Non-empty strings, at least one, no repeats. */
  values: readonly [string, ...string[]];
}

export type PrimitiveField = StringField | IntegerField | NumberField | BooleanField | EnumField;

export interface ArrayField extends FieldCommon {
  type: 'array';
  /** Each entry's shape. A primitive only — no nested arrays, no objects. */
  of: PrimitiveField;
  min?: number;
  /** Required, for the same reason as a string's. */
  max: number;
}

export type FieldSpec = PrimitiveField | ArrayField;

/** What an action accepts, field by field. `{}` is an action that takes nothing. */
export type AddonInput = Readonly<Record<string, FieldSpec>>;

declare const OUTPUT_TYPE: unique symbol;

/**
 * What an action answers, for the type system only. Built by `addonOutput<T>()`, which is
 * `undefined` at run time: it never crosses the export, and the server does not validate an
 * add-on's answers — a wrong answer is the add-on's bug, not an attack on micaOS.
 */
export interface AddonOutput<T> {
  readonly [OUTPUT_TYPE]: T;
}

/** Attach an action's answer type: `output: addonOutput<Entry[]>()`. `undefined` at run time. */
export const addonOutput = <T>(): AddonOutput<T> => undefined as unknown as AddonOutput<T>;

export interface AddonActionSpec {
  input: AddonInput;
  output?: AddonOutput<unknown>;
}

export interface AddonServiceDeclaration {
  /** The add-on's app id, lower_snake_case. Never a core service or app id. */
  id: string;
  /** `ADDON_SERVICE_FORMAT_VERSION`, when given. Absent means 1. */
  format?: number;
  actions: Readonly<Record<string, AddonActionSpec>>;
}

// --- Types derived from a declaration -------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type KindOf<F> = F extends { type: 'string' }
  ? string
  : F extends { type: 'integer' } | { type: 'number' }
    ? number
    : F extends { type: 'boolean' }
      ? boolean
      : F extends { type: 'enum'; values: readonly (infer V extends string)[] }
        ? V
        : F extends { type: 'array'; of: infer O }
          ? FieldValue<O>[]
          : never;

/** The value one field yields once parsed. */
export type FieldValue<F> = F extends { nullable: true } ? KindOf<F> | null : KindOf<F>;

type OptionalKeys<I> = { [K in keyof I]: I[K] extends { optional: true } ? K : never }[keyof I];

/** The object an input declaration parses to: an `optional` field is an optional property. */
export type InputOf<I> = Simplify<
  { -readonly [K in Exclude<keyof I, OptionalKeys<I>>]: FieldValue<I[K]> } & {
    -readonly [K in OptionalKeys<I>]?: FieldValue<I[K]>;
  }
>;

export type AddonActionName<D extends AddonServiceDeclaration> = keyof D['actions'] & string;

/** What a handler is handed as `input` for this action, already parsed. */
export type AddonActionInput<
  D extends AddonServiceDeclaration,
  A extends AddonActionName<D>
> = InputOf<D['actions'][A]['input']>;

/** What the action answers, if `addonOutput<T>()` declared it; `unknown` otherwise. */
export type AddonActionOutput<
  D extends AddonServiceDeclaration,
  A extends AddonActionName<D>
> = D['actions'][A] extends { output: AddonOutput<infer T> } ? T : unknown;

/**
 * A refusal the player should read. A handler answers it instead of a result, and micaOS shows
 * `message` (trimmed, at most `ADDON_ERROR_MESSAGE_MAX` characters) as the toast. Any other
 * failure — a throw, a rejection, a timeout, an answer that is not JSON — reaches the player as
 * micaOS's generic failure, and only the server log says why.
 */
export interface AddonErrorAnswer {
  error: { message: string };
}

export const ADDON_ERROR_MESSAGE_MAX = 160;

/** `return addonError('That entry is not yours.')`. From Lua: `return { error = { message = … } }`. */
export const addonError = (message: string): AddonErrorAnswer => ({ error: { message } });

export type AddonHandler<D extends AddonServiceDeclaration, A extends AddonActionName<D>> = (
  citizenid: string,
  input: AddonActionInput<D, A>,
  source: number
) =>
  | AddonActionOutput<D, A>
  | AddonErrorAnswer
  | PromiseLike<AddonActionOutput<D, A> | AddonErrorAnswer>;

/** One handler per declared action, and nothing else: what `RegisterService` takes beside it. */
export type AddonHandlers<D extends AddonServiceDeclaration> = {
  [A in AddonActionName<D>]: AddonHandler<D, A>;
};

// --- Validation -----------------------------------------------------------------------------

export type AddonServiceCheck =
  { ok: true; value: AddonServiceDeclaration } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A Lua table with nothing in it crosses an export as `[]`, not `{}` — msgpack cannot tell an
 * empty table's intent. So an empty list stands for an empty map wherever a map is expected.
 */
const asMap = (value: unknown): Record<string, unknown> | null => {
  if (Array.isArray(value) && value.length === 0) return {};
  return isRecord(value) ? value : null;
};

/**
 * A key `s.object` would trip over: `__proto__` would set the prototype of the parsed value,
 * and anything `Object.prototype` already has (`toString`, `constructor`) answers `in` for a
 * payload that never sent it.
 */
const isReservedKey = (key: string): boolean => key === '__proto__' || key in Object.prototype;

class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const ALLOWED_KEYS: Record<FieldSpec['type'], readonly string[]> = {
  string: ['type', 'optional', 'nullable', 'min', 'max'],
  integer: ['type', 'optional', 'nullable', 'min', 'max'],
  number: ['type', 'optional', 'nullable', 'min', 'max'],
  boolean: ['type', 'optional', 'nullable'],
  enum: ['type', 'optional', 'nullable', 'values'],
  array: ['type', 'optional', 'nullable', 'of', 'min', 'max']
};

const isKind = (value: unknown): value is FieldSpec['type'] =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, value);

const optionalFlag = (raw: Record<string, unknown>, key: string, at: string): boolean => {
  const value = raw[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') refuse(`${at}: '${key}' must be true or false.`);
  return value as boolean;
};

/** A count bound: a non-negative whole number, at most `ceiling`. */
const countBound = (
  raw: Record<string, unknown>,
  key: string,
  at: string,
  ceiling: number,
  required: boolean
): number | undefined => {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) refuse(`${at}: '${key}' is required — an unbounded value is a flood.`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return refuse(`${at}: '${key}' must be a whole number, 0 or more.`);
  }
  if (value > ceiling) refuse(`${at}: '${key}' may be at most ${ceiling}.`);
  return value;
};

/** A value bound on a number field: finite, and a safe integer on an `integer` field. */
const valueBound = (
  raw: Record<string, unknown>,
  key: string,
  at: string,
  integer: boolean
): number | undefined => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return refuse(`${at}: '${key}' must be a number.`);
  }
  if (integer && !Number.isSafeInteger(value)) refuse(`${at}: '${key}' must be a whole number.`);
  return value;
};

const ordered = (min: number | undefined, max: number | undefined, at: string): void => {
  if (min !== undefined && max !== undefined && min > max) {
    refuse(`${at}: 'min' is larger than 'max'.`);
  }
};

const checkField = (raw: unknown, at: string, inArray: boolean): FieldSpec => {
  if (!isRecord(raw)) {
    return refuse(`${at} must be a field table like { type = 'string', max = 80 }.`);
  }
  const kind = raw.type;
  if (!isKind(kind)) {
    return refuse(
      `${at}: unknown type '${String(kind)}'. Format ${ADDON_SERVICE_FORMAT_VERSION} knows ` +
        `${Object.keys(ALLOWED_KEYS).join(', ')} — and no nested objects.`
    );
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS[kind].includes(key)) {
      refuse(`${at}: '${key}' is not an option of a ${kind} field.`);
    }
  }

  const common: FieldCommon = {};
  if (optionalFlag(raw, 'optional', at)) {
    if (inArray) refuse(`${at}: an array's entries cannot be optional; use nullable.`);
    common.optional = true;
  }
  if (optionalFlag(raw, 'nullable', at)) common.nullable = true;

  switch (kind) {
    case 'string': {
      const min = countBound(raw, 'min', at, ADDON_SERVICE_LIMITS.stringMax, false);
      const max = countBound(raw, 'max', at, ADDON_SERVICE_LIMITS.stringMax, true) as number;
      ordered(min, max, at);
      return { type: 'string', ...common, ...(min === undefined ? {} : { min }), max };
    }
    case 'integer':
    case 'number': {
      const min = valueBound(raw, 'min', at, kind === 'integer');
      const max = valueBound(raw, 'max', at, kind === 'integer');
      ordered(min, max, at);
      return {
        type: kind,
        ...common,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max })
      };
    }
    case 'boolean':
      return { type: 'boolean', ...common };
    case 'enum': {
      const values = raw.values;
      if (!Array.isArray(values) || values.length === 0) {
        return refuse(`${at}: 'values' must be a non-empty list of strings.`);
      }
      if (values.length > ADDON_SERVICE_LIMITS.enumValues) {
        refuse(`${at}: at most ${ADDON_SERVICE_LIMITS.enumValues} values.`);
      }
      const seen = new Set<string>();
      for (const value of values) {
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > ADDON_SERVICE_LIMITS.enumValueLength
        ) {
          refuse(
            `${at}: every value must be a non-empty string of at most ` +
              `${ADDON_SERVICE_LIMITS.enumValueLength} characters.`
          );
        }
        if (seen.has(value)) refuse(`${at}: '${value}' is listed twice.`);
        seen.add(value);
      }
      return { type: 'enum', ...common, values: [...seen] as [string, ...string[]] };
    }
    case 'array': {
      if (inArray) return refuse(`${at}: an array's entries cannot be arrays.`);
      const of = checkField(raw.of, `${at}.of`, true) as PrimitiveField;
      const min = countBound(raw, 'min', at, ADDON_SERVICE_LIMITS.arrayMax, false);
      const max = countBound(raw, 'max', at, ADDON_SERVICE_LIMITS.arrayMax, true) as number;
      ordered(min, max, at);
      return { type: 'array', ...common, of, ...(min === undefined ? {} : { min }), max };
    }
  }
};

const checkInput = (raw: unknown, at: string): AddonInput => {
  const fields = asMap(raw);
  if (!fields) {
    return refuse(`${at}: 'input' must be a table of fields ({} for an action taking nothing).`);
  }
  const names = Object.keys(fields);
  if (names.length > ADDON_SERVICE_LIMITS.fieldsPerAction) {
    refuse(`${at}: at most ${ADDON_SERVICE_LIMITS.fieldsPerAction} fields.`);
  }
  const out: Record<string, FieldSpec> = {};
  for (const name of names) {
    if (
      !FIELD_NAME.test(name) ||
      name.length > ADDON_SERVICE_LIMITS.fieldLength ||
      isReservedKey(name)
    ) {
      refuse(
        `${at}: '${name}' is not a usable field name (letters, digits and _, at most ` +
          `${ADDON_SERVICE_LIMITS.fieldLength}, and not a name every object already has).`
      );
    }
    out[name] = checkField(fields[name], `${at}.${name}`, false);
  }
  return out;
};

const checkAction = (raw: unknown, at: string): AddonActionSpec => {
  if (!isRecord(raw)) return refuse(`${at} must be a table with an 'input'.`);
  for (const key of Object.keys(raw)) {
    if (key !== 'input' && key !== 'output') refuse(`${at}: '${key}' is not an action option.`);
  }
  if (!('input' in raw) || raw.input === undefined || raw.input === null) {
    // There is no "accept anything" mode: an action with no schema is an action nobody wrote
    // a rule for, which is the state `defineContract` exists to stop in core.
    refuse(`${at} declares no 'input'. Use {} for an action that takes nothing.`);
  }
  if (raw.output !== undefined && raw.output !== null) {
    refuse(`${at}: 'output' is type-only. Use addonOutput<T>(), which is undefined at run time.`);
  }
  return { input: checkInput(raw.input, at) };
};

/**
 * Check a declaration that arrived from anywhere — another resource's export call, a Lua
 * table — and return a normalized copy, or the first reason it is refused.
 *
 * The copy carries only what was checked: an unexpected key cannot ride along, and a Lua `[]`
 * that meant `{}` comes out as `{}`.
 */
export function checkAddonService(raw: unknown): AddonServiceCheck {
  try {
    if (!isRecord(raw)) refuse("A declaration is a table with an 'id' and 'actions'.");
    const decl = raw as Record<string, unknown>;
    for (const key of Object.keys(decl)) {
      if (key !== 'id' && key !== 'format' && key !== 'actions') {
        refuse(`'${key}' is not a declaration option.`);
      }
    }
    if (decl.format !== undefined && decl.format !== null) {
      if (decl.format !== ADDON_SERVICE_FORMAT_VERSION) {
        refuse(
          `This micaOS reads format ${ADDON_SERVICE_FORMAT_VERSION}, not ${String(decl.format)}.`
        );
      }
    }

    const id = decl.id;
    if (
      typeof id !== 'string' ||
      !ADDON_SERVICE_ID.test(id) ||
      id.length > ADDON_SERVICE_LIMITS.idLength
    ) {
      refuse(
        `'${String(id)}' is not a service id: lower_snake_case, at most ` +
          `${ADDON_SERVICE_LIMITS.idLength} characters — the add-on's app id.`
      );
    }
    if ((id as string).startsWith(EXTERNAL_PREFIX)) {
      refuse(`'${EXTERNAL_PREFIX}' ids are reserved for SendNotification's external groups.`);
    }

    const actions = asMap(decl.actions);
    if (!actions || Object.keys(actions).length === 0) {
      refuse("'actions' must name at least one action.");
    }
    const names = Object.keys(actions as Record<string, unknown>);
    if (names.length > ADDON_SERVICE_LIMITS.actions) {
      refuse(`At most ${ADDON_SERVICE_LIMITS.actions} actions.`);
    }
    const out: Record<string, AddonActionSpec> = {};
    for (const name of names) {
      if (
        !ADDON_ACTION_NAME.test(name) ||
        name.length > ADDON_SERVICE_LIMITS.actionLength ||
        isReservedKey(name)
      ) {
        refuse(
          `'${name}' is not an action name: starts lowercase, letters, digits and _, at most ` +
            `${ADDON_SERVICE_LIMITS.actionLength} characters.`
        );
      }
      out[name] = checkAction((actions as Record<string, unknown>)[name], `actions.${name}`);
    }
    return { ok: true, value: { id: id as string, actions: out } };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Freeze `value` and everything reachable from it. A declaration is plain data, so no cycles. */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

/**
 * Declare an add-on's service. Returns the declaration itself, so the object an author wrote
 * is the one the export carries and the one the UI's types read; throws with the reason when
 * it is not one micaOS would accept, so the mistake surfaces where it was made rather than as
 * an `invalid_args` from the export.
 *
 * **Deep-frozen.** The id is traced from this literal (the SDK's permissions scan reads it), so
 * nothing may change it afterwards: `journal.id = 'other'` throws in strict mode and does
 * nothing otherwise, and so does any write to an action or a field.
 */
export function defineAddonService<const D extends AddonServiceDeclaration>(declaration: D): D {
  const checked = checkAddonService(declaration);
  if (!checked.ok) {
    throw new Error(`defineAddonService('${String(declaration?.id)}'): ${checked.reason}`);
  }
  return deepFreeze(declaration);
}

// --- Translation to @mica/shared/schema -----------------------------------------------------

const fieldSchema = (field: FieldSpec): GphoneSchema<unknown> => {
  let schema: GphoneSchema<unknown>;
  switch (field.type) {
    case 'string':
      schema = s.string({ min: field.min, max: field.max });
      break;
    case 'integer':
      schema = s.int({ min: field.min, max: field.max });
      break;
    case 'number':
      schema = s.number({ min: field.min, max: field.max });
      break;
    case 'boolean':
      schema = s.boolean();
      break;
    case 'enum':
      schema = s.enum(field.values);
      break;
    case 'array':
      schema = s.array(fieldSchema(field.of), { min: field.min, max: field.max });
      break;
  }
  if (field.nullable) schema = schema.nullable();
  if (field.optional) schema = schema.optional();
  return schema;
};

/**
 * The validator for one action's input: an `s.object` over its fields, strict about unknown
 * keys like every core contract.
 *
 * One addition in front: a payload of `undefined` or `null` is read as `{}`. The relay
 * produces either for a call with no arguments, and an action whose fields are all optional
 * would otherwise refuse the call it most plainly accepts. A required field still refuses,
 * because `{}` is then checked like any other object.
 */
export function addonInputSchema<const I extends AddonInput>(
  input: I
): StandardSchemaV1<unknown, InputOf<I>> {
  const shape: Record<string, GphoneSchema<unknown>> = {};
  for (const [name, field] of Object.entries(input)) shape[name] = fieldSchema(field);
  const object = s.object(shape);
  return {
    '~standard': {
      version: 1,
      vendor: 'mica',
      // Every `s` schema resolves synchronously, and an add-on cannot hand in a foreign one:
      // a declaration is data, and only this file turns it into validators.
      validate: (value: unknown) =>
        object['~standard'].validate(
          value === undefined || value === null ? {} : value
        ) as StandardSchemaResult<InputOf<I>>
    }
  };
}

/** Every action's validator, keyed by action name. */
export function addonActionSchemas(
  declaration: AddonServiceDeclaration
): Record<string, StandardSchemaV1<unknown, unknown>> {
  const out: Record<string, StandardSchemaV1<unknown, unknown>> = {};
  for (const [name, action] of Object.entries(declaration.actions)) {
    out[name] = addonInputSchema(action.input);
  }
  return out;
}
