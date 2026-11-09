// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every NUI callback the client registers, sent the payloads injected script would send
 * (MICA-466).
 *
 * AGENTS.md §7: any script running in the CEF page can `fetch` any registered NUI callback,
 * so a `RegisterNuiCallbackType` handler gets the suspicion the server gives a net payload.
 * `server/__tests__/hostilePayloads.test.ts` is the server's half of the same sweep.
 *
 * **Which callbacks** comes from two places that must agree. The source scan below reads every
 * `RegisterNuiCallbackType(...)` and `on('__cfx_nui:...')` under `client/`; a literal name is
 * taken as written, and a name reached through a variable has to be one of the
 * `DYNAMIC_SITES`, resolved from the same table the code reads. The load is `../client` itself,
 * with every native stubbed (`nuiHarness.ts`), capturing what actually registered. A callback
 * the scan finds but the load cannot reach fails the census, and so does one the load reaches
 * that the scan cannot explain. Everything registered is swept; nothing is skipped quietly.
 *
 * **The oracle is generic, never a table per callback.** Each case is held to:
 *
 * - **The page is answered**: `cb` exactly once, no synchronous throw, no rejected promise.
 *   FiveM awaits nothing an `on` handler returns, so a throw leaves `fetchNui` hanging.
 * - **No prototype gains a property**, the one thing an own `__proto__` key could do here.
 * - **Nothing hostile reaches a sink.** The sinks are `emitNet`/`TriggerServerEvent`, every
 *   native, and another resource's exports, recorded only while the case runs; `SendNuiMessage`
 *   and the `cb` reply are not sinks, because they answer the page that sent the payload. A
 *   sink argument fails on an own `__proto__`/`constructor`/`prototype` key, an undeclared key,
 *   a string of 64 KiB or more, or a non-finite number; a server event fails when a payload
 *   value is in its name. A native takes only finite numbers, booleans and strings.
 * - **A field reaches a sink as one JSON type.** Each key a handler reads (found with a
 *   recording proxy) is sent as an object, an array, a number and a string in turn; a sink
 *   position that received two of those was handed the field unchecked. Coercion passes —
 *   `Boolean(x)` or a finite-checked `Number(x)` maps a hostile value onto something a
 *   well-formed payload could already have produced, which is no escalation.
 *
 * **Forwarding a payload for the server to re-check** passes only where that re-check is
 * proven: an event in `COVERED`, the set the server's own hostile sweep
 * (`server/__tests__/hostilePayloads.test.ts`, MICA-463) holds to every payload this file sends.
 * What `emitNet` carries to one of those is the server's to judge, and the content rules above
 * are not applied to it. Everything else stays strict: an event outside the set, every native,
 * every other resource's export, the event name itself, and a `clientPrepared` field — which
 * the server takes as the client's word, so the page must never be the one choosing it.
 *
 * What this cannot see: whether CEF's JSON decode hands the scripting runtime an own
 * `__proto__` key at all, how msgpack carries what `emitNet` is given, and what any native
 * really does in the game. The natives here answer zeros; their effect is unverified.
 */
import {
  MARK,
  MARK_NUMBER,
  OVERSIZE,
  invoke,
  keysRead,
  landings,
  nuiHandlers,
  registeredNuiTypes,
  sinkProblems,
  type JsonType,
  type NuiHandler,
  type Outcome,
  type SinkCall
} from './nuiHarness';
import '../client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLIENT_ONLY_ACTIONS, ROUTES, serverEventFor } from '@mica/shared/routes';
import { ADDON_SERVICE_LIMITS } from '@mica/shared/addonService';
import {
  FIELDS_WITHOUT_A_WRONG_TYPE,
  RAW_ARGUMENTS_NOT_VARIED
} from '../../server/__tests__/schemaShapes';
import { GENERIC_SERVICE_ACTION, requestEventFor } from '@mica/shared/rpc';
import { actionsOf, allContracts, isClientPrepared } from '@mica/shared/contract';
import { DeviceState } from '../lib/DeviceState';
import { PhoneCamera } from '../game/PhoneCamera';
import { sorted } from './arrays';

const ROOT = join(__dirname, '..', '..');
const CLIENT = join(ROOT, 'client');

/**
 * Registration sites whose name is not a literal, and what each resolves to — read from the
 * same table the code iterates, so a new route is swept with no edit here. A non-literal site
 * not listed fails the census until somebody says what it registers.
 */
const DYNAMIC_SITES: Record<string, () => readonly string[]> = {
  // `registerCallback(route.action, ...)`, called once per route by `Relay.ts`.
  'client/lib/ServiceProxy.ts:nuiEvent': () => ROUTES.map((r) => r.action),
  'client/services/Relay.ts:GENERIC_SERVICE_ACTION': () => [GENERIC_SERVICE_ACTION]
};

/**
 * Callbacks registered but not swept, each with the reason. Empty: every one is loadable with
 * the natives stubbed. An entry here is asserted, never assumed.
 */
const UNSWEPT: Record<string, string> = {};

/** Every contracted action as `[service, action]`, prepared or not, in a stable order. */
const CONTRACTED = allContracts()
  .map((c) => c.id)
  .sort()
  .flatMap((id) => {
    const contract = allContracts().find((c) => c.id === id);
    return contract ? actionsOf(contract).map((a) => [contract, a] as const) : [];
  });

/** The first contracted action whose data the relay forwards as the page sent it. */
const PLAIN = CONTRACTED.find(([c, a]) => !isClientPrepared(c, a));

/**
 * Siblings a field needs before the handler goes far enough to use it. Only the generic relay
 * has one: it refuses a request whose service or action is malformed before it reads `data`.
 * The base names a real contracted action, read from the contracts rather than written here,
 * so a forward to it is one the server's sweep covers; `holds an uncovered event strict`
 * below is the case of an add-on's own service, which it does not.
 */
const BASES: Record<string, Record<string, unknown>> = {
  [GENERIC_SERVICE_ACTION]: { service: PLAIN?.[0].id, action: PLAIN?.[1] }
};

// ---------------------------------------------------------------------------------------------
// The source scan
// ---------------------------------------------------------------------------------------------

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });

/** A registration's argument: a quoted literal, or the identifier a template or call names. */
const argumentOf = (raw: string): { literal: string } | { identifier: string } | null => {
  const literal = /^(['"])([^'"]+)\1$/.exec(raw.trim());
  if (literal) return { literal: literal[2] as string };
  const template = /^`__cfx_nui:\$\{(\w+)\}`$/.exec(raw.trim());
  if (template) return { identifier: template[1] as string };
  const bare = /^(\w+)$/.exec(raw.trim());
  if (bare) return { identifier: bare[1] as string };
  return null;
};

interface Scan {
  /** Names registered by a literal, from `RegisterNuiCallbackType('<name>')`. */
  literalTypes: string[];
  /** Names from `on('__cfx_nui:<name>')`. */
  literalHandlers: string[];
  /** `<file>:<identifier>` for every non-literal site, of either kind. */
  dynamicSites: string[];
  /** What the scan could not read, each with where. */
  unreadable: string[];
}

const scanSource = (): Scan => {
  const scan: Scan = { literalTypes: [], literalHandlers: [], dynamicSites: [], unreadable: [] };
  for (const file of sourceFiles(CLIENT)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    // Comments name these calls too; only code registers anything.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const m of code.matchAll(/\bRegisterNuiCallbackType\(([^)]*)\)/g)) {
      const arg = argumentOf(m[1] as string);
      if (!arg) scan.unreadable.push(`${rel}: RegisterNuiCallbackType(${m[1]})`);
      else if ('literal' in arg) scan.literalTypes.push(arg.literal);
      else scan.dynamicSites.push(`${rel}:${arg.identifier}`);
    }
    // The two-argument form registers and handles at once; nothing uses it, and if something
    // starts to, the census has to learn it rather than miss it.
    for (const m of code.matchAll(/\bRegisterNuiCallback\(([^,)]*)/g)) {
      scan.unreadable.push(`${rel}: RegisterNuiCallback(${m[1]}, ...) is not in the census`);
    }

    let handlerSites = 0;
    for (const m of code.matchAll(
      /\bon\(\s*('__cfx_nui:[^']*'|"__cfx_nui:[^"]*"|`__cfx_nui:[^`]*`)/g
    )) {
      handlerSites++;
      const raw = m[1] as string;
      const arg = raw.startsWith('`') ? argumentOf(raw) : argumentOf(raw.replace('__cfx_nui:', ''));
      if (!arg) scan.unreadable.push(`${rel}: on(${raw})`);
      else if ('literal' in arg) scan.literalHandlers.push(arg.literal);
      else scan.dynamicSites.push(`${rel}:${arg.identifier}`);
    }
    const mentions = code.match(/__cfx_nui:/g)?.length ?? 0;
    if (mentions !== handlerSites) {
      scan.unreadable.push(
        `${rel}: ${mentions} '__cfx_nui:' in code but ${handlerSites} on(...) the scan can read`
      );
    }
  }
  return scan;
};

const scan = scanSource();
const resolvedDynamic = [...new Set(scan.dynamicSites)].flatMap(
  (site) => DYNAMIC_SITES[site]?.() ?? []
);
const expected = sorted([...new Set([...scan.literalTypes, ...resolvedDynamic])]);
const registered = sorted([...new Set(registeredNuiTypes)]);
const SWEPT = registered.filter((name) => !(name in UNSWEPT));

describe('the census: every NUI callback, from the source and from the load', () => {
  it('reads every registration site in client/', () => {
    expect(scan.unreadable).toEqual([]);
  });

  it('resolves every non-literal site, and lists none that no longer exists', () => {
    const sites = sorted([...new Set(scan.dynamicSites)]);
    expect(sites).toEqual(sorted(Object.keys(DYNAMIC_SITES)));
  });

  it('loads exactly the callbacks the scan finds', () => {
    // Both directions: one the scan finds but the load never registered is a callback this
    // file would believe swept; one the load registered that the scan cannot name is a
    // registration path the scan has gone blind to.
    expect(registered).toEqual(expected);
    expect(registered.length).toBeGreaterThan(0);
  });

  it('registers each callback once, with exactly one handler', () => {
    const counts = new Map<string, number>();
    for (const name of registeredNuiTypes) counts.set(name, (counts.get(name) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n !== 1)).toEqual([]);
    expect(sorted([...nuiHandlers.keys()])).toEqual(expected);
    expect([...nuiHandlers].filter(([, hs]) => hs.length !== 1).map(([n]) => n)).toEqual([]);
  });

  it('pairs every literal registration with a literal handler', () => {
    expect(sorted(scan.literalHandlers)).toEqual(sorted(scan.literalTypes));
  });

  it("finds the literal callbacks to be exactly routes.ts's CLIENT_ONLY_ACTIONS", () => {
    expect(sorted(scan.literalTypes)).toEqual(sorted(CLIENT_ONLY_ACTIONS));
  });

  it('sweeps every registered callback but the asserted unswept list', () => {
    for (const name of Object.keys(UNSWEPT)) expect(registered).toContain(name);
    expect(sorted([...SWEPT, ...Object.keys(UNSWEPT)])).toEqual(registered);
  });
});

// ---------------------------------------------------------------------------------------------
// What the server's own sweep covers
// ---------------------------------------------------------------------------------------------

/**
 * Every `mica:server:*` event literal a call named `callee` takes first, in non-test source under
 * `dir` — the scan `server/__tests__/netEventPairs.test.ts` pairs the two trees with.
 */
const eventLiterals = (dir: string, callee: string): string[] => {
  const found = new Set<string>();
  const call = new RegExp(`\\b${callee}\\(\\s*['"\`](mica:server:[^'"\`]+)['"\`]`, 'g');
  for (const file of sourceFiles(join(ROOT, dir))) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    for (const m of code.matchAll(call)) found.add(m[1] as string);
  }
  return [...found];
};

/** The raw `onNet` handlers the server registers by name. */
const RAW_SERVER_EVENTS = eventLiterals('server', 'onNet');

/**
 * The events the server's hostile sweep sends every payload in this file to (MICA-463).
 *
 * That sweep enumerates what registered: the generic CRUD actions from their declarations, the
 * custom actions from their contracts, and the raw handlers. The same three, read from the
 * sources that cannot import the server: `ROUTES` (each one's registration is held by
 * `routes.test.ts`), every shared contract (held by `reachability.test.ts`), and the raw
 * `onNet` literals (held to the client's raw sends by `netEventPairs.test.ts`). An in-tree
 * add-on that declares its contract under `server/` alone — `notes` — is swept there and counts
 * as uncovered here, which errs strict.
 */
const COVERED = new Set([
  ...ROUTES.map(serverEventFor),
  ...CONTRACTED.map(([c, a]) => requestEventFor(c.id, a)),
  ...RAW_SERVER_EVENTS
]);

/** A payload path as the server sweep writes one — `a.b`, `list[0].x` — as its steps. */
const stepsOf = (path: string): (string | number)[] =>
  [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) =>
    m[2] !== undefined ? Number(m[2]) : (m[1] as string)
  );

/**
 * Only what sits at `path` in `value`, in a skeleton of the same shape, or undefined when
 * nothing is there — so a strict check sees the pinned field and none of its siblings.
 */
const pick = (value: unknown, path: string): unknown => {
  const steps = stepsOf(path);
  let at: unknown = value;
  for (const step of steps) {
    if (!at || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, step)) {
      return undefined;
    }
    at = (at as Record<string | number, unknown>)[step];
  }
  return steps.reduceRight<unknown>((inner, step) => {
    if (typeof step === 'number') {
      const list: unknown[] = [];
      list[step] = inner;
      return list;
    }
    return Object.defineProperty({}, step, { value: inner, enumerable: true });
  }, at);
};

/**
 * What of one sink call this file still judges.
 *
 * All of it, unless it is a server event in `COVERED`; then only the parts the server sweep
 * does not vary — its pinned lists, exported for exactly this (`schemaShapes.ts`): a payload
 * field it sends no wrong type to (`settings:set`'s `value`), and a raw argument it sends only
 * the shape-free cases (`shell:setOpen`'s first). The covered remainder is the server's to
 * judge. Positions are kept, so a report still names the argument a problem was found in.
 */
const judged = (call: SinkCall): SinkCall | null => {
  const event = String(call.args[0]);
  if (call.kind !== 'server' || !COVERED.has(event)) return call;
  const args: unknown[] = call.args.map((_, i) => (i === 0 ? event : undefined));
  let kept = false;
  for (const { field } of FIELDS_WITHOUT_A_WRONG_TYPE.filter((f) => f.event === event)) {
    // An endpoint event is `(event, cbId, data, device)`: the payload is the third argument.
    const value = pick(call.args[2], field);
    if (value === undefined) continue;
    args[2] = value;
    kept = true;
  }
  for (const { arg } of RAW_ARGUMENTS_NOT_VARIED.filter((r) => r.event === event)) {
    // A raw event is `(event, ...args)`: argument `arg` is one past it.
    args[arg + 1] = call.args[arg + 1];
    kept = true;
  }
  return kept ? { ...call, args } : null;
};

/** The problems the oracle still finds in one sink call. */
const problemsOf = (call: SinkCall): string[] => {
  const kept = judged(call);
  return kept ? sinkProblems(kept) : [];
};

describe('the covered set', () => {
  it('finds the raw handlers, so the set is not just the relay', () => {
    // Nine raw handlers in `docs/security.md`'s census; a scan that read none would pass.
    expect(RAW_SERVER_EVENTS.length).toBeGreaterThanOrEqual(9);
  });

  it('holds every raw event the client sends by name', () => {
    const sent = eventLiterals('client', 'TriggerServerEvent');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((event) => !COVERED.has(event))).toEqual([]);
  });

  it('holds no event whose segments the relay would refuse', () => {
    // The relay's bound (`Relay.ts`) is `defineAddonService`'s, and must admit every real name.
    const tooLong = [...COVERED].filter((event) => {
      const [, , service = '', action = ''] = event.split(':');
      return (
        service.length > ADDON_SERVICE_LIMITS.idLength ||
        action.length > ADDON_SERVICE_LIMITS.actionLength
      );
    });
    expect(tooLong).toEqual([]);
  });

  it("subtracts every field and argument the server's sweep does not vary", () => {
    // Both lists non-empty and every entry an event this file would otherwise relax, so the
    // loop below proves something; then each entry stays strict and its siblings do not.
    expect(FIELDS_WITHOUT_A_WRONG_TYPE.length).toBeGreaterThan(0);
    expect(RAW_ARGUMENTS_NOT_VARIED.length).toBeGreaterThan(0);
    const server = (args: unknown[]): SinkCall => ({ kind: 'server', sink: 'emitNet', args });
    const hostile = () => json(UNKNOWN);
    const at = (path: string): Record<string, unknown> =>
      stepsOf(path).reduceRight<Record<string, unknown>>(
        (inner, step) => ({ [String(step)]: inner }),
        hostile() as Record<string, unknown>
      );

    for (const { event, field } of FIELDS_WITHOUT_A_WRONG_TYPE) {
      expect(COVERED.has(event), event).toBe(true);
      expect(
        problemsOf(server([event, 'cb', at(field), 'phone'])),
        `${event} ${field}`
      ).not.toEqual([]);
      expect(
        problemsOf(server([event, 'cb', { [`${MARK}_sibling`]: hostile() }, 'phone']))
      ).toEqual([]);
    }
    for (const { event, arg } of RAW_ARGUMENTS_NOT_VARIED) {
      expect(COVERED.has(event), event).toBe(true);
      const pinned: unknown[] = [event];
      pinned[arg + 1] = hostile();
      expect(problemsOf(server(pinned)), `${event}[${arg}]`).not.toEqual([]);
      const other: unknown[] = [event];
      other[arg + 2] = hostile();
      expect(problemsOf(server(other))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

/** A payload as the page would send it: parsed from JSON, so `__proto__` is an own key. */
const json = (text: string): unknown => JSON.parse(text);

const BIG = `"${MARK}_big${'x'.repeat(OVERSIZE)}"`;
const UNKNOWN = `{"${MARK}_unknown":"x"}`;
const PROTO = `{"__proto__":{"${MARK}_polluted":true}}`;
const CTOR = `{"constructor":{"prototype":{"${MARK}_polluted":true}}}`;

/**
 * The whole payload replaced, or extended, as injected script could. A type, where there is
 * one, is what `landings` tells apart: the whole payload reaching one sink position as two
 * types was never checked.
 */
const WHOLE: [string, JsonType | null, (base: Record<string, unknown>) => unknown][] = [
  ['missing payload (undefined)', null, () => undefined],
  ['missing payload (null)', null, () => null],
  ['payload a string', 'string', () => json(`"${MARK}_str"`)],
  ['payload a number', 'number', () => json(String(MARK_NUMBER))],
  ['payload a boolean', null, () => json('true')],
  ['payload an array', 'array', () => json(`["${MARK}_arr"]`)],
  ['payload an oversized string', 'string', () => json(BIG)],
  ['an undeclared key', 'object', (b) => Object.assign(json(UNKNOWN) as object, b)],
  ['an own __proto__ key', null, (b) => Object.assign(json(PROTO) as object, b)],
  ['an own constructor key', null, (b) => Object.assign(json(CTOR) as object, b)]
];

/** One field replaced, with the same meaning for a type. */
const FIELD: [string, JsonType | null, () => unknown][] = [
  ['an object with an undeclared key', 'object', () => json(UNKNOWN)],
  ['an array', 'array', () => json(`["${MARK}_arr"]`)],
  ['a number', 'number', () => json(String(MARK_NUMBER))],
  ['a string', 'string', () => json(`"${MARK}_str"`)],
  ['an oversized string', 'string', () => json(BIG)],
  ['an own __proto__ key', null, () => json(PROTO)],
  ['an own constructor key', null, () => json(CTOR)],
  ['Infinity (1e999)', null, () => json('1e999')],
  ['a boolean', null, () => json('true')],
  ['null', null, () => json('null')],
  // Oversized, and shaped like an event segment: the marked strings all start `__`, which a
  // segment check refuses outright, so without this one no case tests a length bound on a
  // name that is interpolated into an event.
  ['a segment-shaped oversized string', null, () => 'a'.repeat(OVERSIZE)]
];

const handlerFor = (name: string): NuiHandler => {
  const handler = nuiHandlers.get(name)?.[0];
  if (!handler) throw new Error(`no handler registered for '${name}'`);
  return handler;
};

/**
 * The state every case starts from: the phone up and its camera on, so a handler that does
 * nothing while the phone is down (`toggleFreelook`) or the camera is off (`flipCamera`) is
 * reached rather than passed vacuously. Set outside the recording window, so none of these
 * natives counts against the case.
 */
const arrange = (): void => {
  PhoneCamera.disable();
  DeviceState.__reset();
  DeviceState.setOpen('phone', true);
  PhoneCamera.enable();
};

/**
 * Problems, each with the cases that showed it. One line per problem rather than per case, so
 * a red reads as the handful of defects it is rather than as a page of repeats.
 */
class Findings {
  private readonly byProblem = new Map<string, string[]>();

  add(problem: string, label: string): void {
    this.byProblem.set(problem, [...(this.byProblem.get(problem) ?? []), label]);
  }

  /** What was wrong with one case's outcome, by the oracle in this file's header. */
  judge(label: string, outcome: Outcome): void {
    if (outcome.threw !== undefined) {
      const error = outcome.threw;
      this.add(`throws: ${error instanceof Error ? error.message : String(error)}`, label);
    }
    if (outcome.answers.length !== 1) {
      this.add(`answers the page ${outcome.answers.length} times, not once`, label);
    }
    for (const key of outcome.polluted) this.add(`pollutes ${key}`, label);
    for (const call of outcome.sinks) {
      for (const problem of problemsOf(call)) this.add(problem, label);
    }
  }

  render(): string {
    return [...this.byProblem]
      .map(([problem, labels]) => `${problem}\n    when sent ${labels.join('; ')}`)
      .join('\n');
  }
}

/** Where a typed hostile value landed, by sink position, and as which types. */
const recordLandings = (
  seen: Map<string, Set<JsonType>>,
  what: string,
  type: JsonType | null,
  outcome: Outcome
): void => {
  if (!type) return;
  const judgedSinks = outcome.sinks.flatMap((call) => judged(call) ?? []);
  for (const landing of landings(judgedSinks)) {
    const key = `${what} reaches ${landing.position}`;
    seen.set(key, (seen.get(key) ?? new Set()).add(type));
  }
};

beforeAll(() => {
  vi.useFakeTimers();
  // The 15-second relay timeout warns once per forwarded case; the warning is not the subject.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('every NUI callback, sent hostile payloads', () => {
  it.each(SWEPT)('%s', async (name) => {
    const handler = handlerFor(name);
    const base = BASES[name] ?? {};
    expect(Object.values(base), `${name}'s base names nothing`).not.toContain(undefined);

    // The control: a payload the page could legitimately send. A handler that cannot answer
    // even this is a harness that never reached it, not a finding.
    arrange();
    const control = await invoke(handler, { ...base });
    expect(control.threw, `${name} threw on its control payload`).toBeUndefined();
    expect(control.answers.length, `${name} did not answer its control payload`).toBe(1);

    arrange();
    // A base key is swept too, one at a time with the others kept: `svc`'s `service` and
    // `action` are the two fields that become part of an event name.
    const fields = await keysRead(handler, base);

    const findings = new Findings();
    const seen = new Map<string, Set<JsonType>>();
    for (const [label, type, build] of WHOLE) {
      arrange();
      const outcome = await invoke(handler, build(base));
      findings.judge(label, outcome);
      recordLandings(seen, 'the payload', type, outcome);
    }
    for (const field of fields) {
      for (const [label, type, value] of FIELD) {
        arrange();
        const outcome = await invoke(handler, { ...base, [field]: value() });
        findings.judge(`'${field}' as ${label}`, outcome);
        recordLandings(seen, `'${field}'`, type, outcome);
      }
    }
    for (const [where, types] of seen) {
      if (types.size > 1) {
        findings.add(`${where} unchecked, as ${sorted([...types]).join(', ')}`, 'each of those');
      }
    }

    expect(findings.render(), `${name} reads ${JSON.stringify(fields)}`).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The generic relay, contract by contract
// ---------------------------------------------------------------------------------------------

/**
 * The relay leaves a contracted action's data to the server, which re-checks it against the
 * same contract — so what is asserted for each is that the page is answered and the request
 * goes to that action's own event and nowhere else. A `clientPrepared` action is the exception:
 * its hook adds what only this client can supply, the server takes that as the client's word,
 * and the page must never be the one supplying it.
 */
const HOOKED = CONTRACTED.filter(([c, a]) => isClientPrepared(c, a)).map(
  ([c, a]) => `${c.id}:${a}`
);

const CONTRACT_DATA: [string, () => unknown][] = [
  ['an undeclared key', () => json(UNKNOWN)],
  ['an own __proto__ key', () => json(PROTO)],
  ['an own constructor key', () => json(CTOR)],
  ['a string', () => json(`"${MARK}_str"`)],
  ['an array', () => json(`["${MARK}_arr"]`)],
  ['a number', () => json(String(MARK_NUMBER))],
  ['null', () => json('null')]
];

/** Problems, each with the actions that showed it. */
const byAction = () => {
  const found = new Map<string, string[]>();
  return {
    add: (problem: string, id: string) => found.set(problem, [...(found.get(problem) ?? []), id]),
    render: (total: number) =>
      [...found]
        .map(([problem, ids]) =>
          ids.length === total
            ? `${problem}\n    every one of the ${total} actions`
            : `${problem}\n    ${ids.length} of ${total}: ${ids.join(', ')}`
        )
        .join('\n')
  };
};

describe('the generic relay, contract by contract', () => {
  it('lists the clientPrepared actions', () => {
    expect(HOOKED).toEqual(['media:shareLocation']);
  });

  it('sends every contracted action to its own covered event, and answers the page once', async () => {
    const handler = handlerFor(GENERIC_SERVICE_ACTION);
    const problems = byAction();
    const plain = CONTRACTED.filter(([c, a]) => !isClientPrepared(c, a));
    expect(plain.length).toBeGreaterThan(0);

    for (const [contract, action] of plain) {
      const id = `${contract.id}:${action}`;
      const event = requestEventFor(contract.id, action);
      if (!COVERED.has(event)) problems.add('is not in the covered set', id);
      for (const [label, data] of CONTRACT_DATA) {
        arrange();
        const outcome = await invoke(handler, {
          service: contract.id,
          action,
          data: data(),
          device: 'phone'
        });
        if (outcome.threw !== undefined || outcome.answers.length !== 1) {
          problems.add(`with ${label}: does not answer the page exactly once`, id);
        }
        const events = outcome.sinks.filter((c) => c.kind === 'server').map((c) => c.args[0]);
        if (events.length !== 1 || events[0] !== event) {
          problems.add(`with ${label}: sends to ${JSON.stringify(events)}`, id);
        }
      }
    }

    expect(problems.render(plain.length)).toBe('');
  });

  it("never lets the page choose a clientPrepared field (the hook's, not the page's)", async () => {
    const handler = handlerFor(GENERIC_SERVICE_ACTION);
    const problems = byAction();
    const g = globalThis as Record<string, unknown>;
    // A real street, so the hook's own value is something the page could try to replace.
    const street = g.GetStreetNameFromHashKey;
    g.GetStreetNameFromHashKey = () => 'Vespucci Boulevard';
    try {
      for (const id of HOOKED) {
        const [service = '', action = ''] = id.split(':');
        const event = requestEventFor(service, action);
        const send = async (data: unknown) => {
          arrange();
          const outcome = await invoke(handler, { service, action, data, device: 'phone' });
          const call = outcome.sinks.find((c) => c.kind === 'server' && c.args[0] === event);
          return { outcome, data: call?.args[2] as Record<string, unknown> | undefined };
        };

        // What the hook adds, found by sending nothing and seeing what arrives.
        const control = await send({});
        const prepared = Object.keys(control.data ?? {});
        if (prepared.length === 0) problems.add('adds no field, so nothing here is tested', id);

        for (const key of prepared) {
          for (const [label, , value] of FIELD) {
            const { outcome, data } = await send({ [key]: value() });
            if (outcome.threw !== undefined || outcome.answers.length !== 1) {
              problems.add(`with '${key}' as ${label}: does not answer the page once`, id);
            }
            if (data?.[key] !== control.data?.[key]) {
              problems.add(`'${key}' as ${label}: the page's value replaced the hook's`, id);
            }
          }
          // And when the native has nothing to say — a road with no name — the page's value
          // must not stand in for it, nor an `undefined` that may cross the wire as `null`.
          g.GetStreetNameFromHashKey = () => '';
          for (const [label, , value] of FIELD) {
            const { data } = await send({ [key]: value() });
            if (data && key in data) {
              problems.add(`'${key}' as ${label}, with no street: still sends '${key}'`, id);
            }
          }
          g.GetStreetNameFromHashKey = () => 'Vespucci Boulevard';
        }
      }
    } finally {
      g.GetStreetNameFromHashKey = street;
    }

    expect(problems.render(HOOKED.length)).toBe('');
  });

  it('holds an uncovered event strict: an add-on service forwarded as sent is still flagged', async () => {
    // The positive twin of the relaxation above, and the add-on door the server's sweep cannot
    // reach: a service the page names that no declaration in this repository registers.
    const findings = new Findings();
    arrange();
    findings.judge(
      'an add-on service',
      await invoke(handlerFor(GENERIC_SERVICE_ACTION), {
        service: 'mica466addon',
        action: 'probe',
        data: json(UNKNOWN)
      })
    );
    expect(findings.render()).toContain(`carries key '${MARK}_unknown'`);
  });

  it("holds a covered event's unvaried field strict: settings:set's value, through the relay", async () => {
    // The relaxation would have passed this: `settings:set` is covered. Its `value` is not
    // varied by the server's sweep (`s.unknown`), so what the page puts there is judged here.
    const [pinned] = FIELDS_WITHOUT_A_WRONG_TYPE;
    expect(pinned?.event).toBe(requestEventFor('settings', 'set'));
    const findings = new Findings();
    arrange();
    findings.judge(
      'settings:set with a hostile value',
      await invoke(handlerFor(GENERIC_SERVICE_ACTION), {
        service: 'settings',
        action: 'set',
        data: { [pinned?.field ?? 'value']: json(UNKNOWN) }
      })
    );
    expect(findings.render()).toContain(`carries key '${MARK}_unknown'`);
  });
});
