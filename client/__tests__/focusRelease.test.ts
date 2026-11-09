// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every path that takes NUI focus gives it back, error paths included (MICA-467).
 *
 * `SetNuiFocus(true, true)` hands the page every input, so no key mapping fires while a device
 * is up: the page's own `hideFrame` is the player's way out, and a page that was never shown
 * cannot send one. A focus nobody releases traps the player, and nothing in the game says so.
 *
 * **Which paths** comes from two places that must agree, the way `hostileNuiPayloads.test.ts`
 * finds its callbacks. The source scan (`sourceGraph.ts`) walks every registration under
 * `client/` — `onNet`, `on`, `RegisterCommand`, `publish` — through everything it references,
 * and calls it an open path when it reaches a `SetNuiFocus(true, …)` or
 * `SetNuiFocusKeepInput(true)`. The load is `../client` with every native stubbed
 * (`nuiHarness.ts`): every registered handler is driven with a set of plausible payloads, with
 * the device down and up, and whichever took focus is an open path. Both must equal
 * {@link PATHS}, so a new path fails here until it is driven below.
 *
 * **Which async steps** comes from the scan too: every `await`, `.then(`, `.catch(` and `void`
 * call in the code a path reaches. Their count per path is pinned ({@link ASYNC_SITE_COUNTS}),
 * and each one must have a failure in {@link ASYNC_FAILURES} — so a new `await` in an open path
 * fails here until somebody says what happens when it never resolves.
 *
 * **The oracle** is one invariant, checked after every case: focus is held exactly when a device
 * is open and its frame was told to show, keep-input is on only while a device is open, and no
 * other frame is shown. Then the page's `hideFrame` must leave everything released. A case is
 * run only after its happy run proved it takes focus, so a refused open cannot pass vacuously.
 *
 * **The page** answers each show with `frameShown` once it has drawn (MICA-475), as the real one
 * does, so every case above runs against a working page. The last block kills it: an open whose
 * page never answers is put down at `FRAME_SHOWN_TIMEOUT_MS`, whichever path raised it.
 *
 * **The failures injected**: a throw at each native the path calls, one at a time, in order
 * (one-shot, so the recovering close can run); each async step never resolving, resolving to
 * nothing, or throwing, both left to run and closed mid-flight; each server gate refusing the
 * open; and a throw at each step of every close, except the releasing calls themselves.
 *
 * What no stub can show: the game's real input capture, CEF's real focus, and what each native
 * does in the game. Every native here answers a zero; if the real `SetNuiFocus(false, false)`
 * did not release, or threw, nothing here would know.
 */
import { commands, netHandlers, nuiHandlers, nativeNames } from './nuiHarness';
import '../client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALL_DEVICES, DEVICES, type DeviceId } from '@mica/shared/devices';
import { DeviceState } from '../lib/DeviceState';
import { closeOpenDevice, FRAME_SHOWN_TIMEOUT_MS } from '../lib/DeviceVisibility';
import { Freelook } from '../game/Freelook';
import { publishedClientExport, publishedClientExports } from '../lib/publicApi';
import { SourceGraph } from './sourceGraph';
import { last, sorted } from './arrays';

const g = globalThis as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Recording, and one-shot failure injection, at every native
// ---------------------------------------------------------------------------------------------

interface Call {
  name: string;
  args: unknown[];
  /** Thrown by injection: it never took effect. */
  threw: boolean;
}

let calls: Call[] = [];
/** The index in `calls` that throws, once. */
let throwAt: number | null = null;
/** Answers that replace a native's stub while a case runs. */
const answers = new Map<string, (...args: unknown[]) => unknown>();

for (const name of new Set([...nativeNames, 'SendNuiMessage', 'TriggerServerEvent', 'emitNet'])) {
  const stub = g[name];
  if (typeof stub !== 'function') continue;
  g[name] = (...args: unknown[]) => {
    const call: Call = { name, args, threw: false };
    calls.push(call);
    if (throwAt === calls.length - 1) {
      throwAt = null;
      call.threw = true;
      throw new Error(`injected failure in ${name}`);
    }
    const result = (answers.get(name) ?? (stub as (...a: unknown[]) => unknown))(...args);
    if (name === 'SendNuiMessage') pageReceives(String(args[0]));
    return result;
  };
}

// ---------------------------------------------------------------------------------------------
// The page, as the client meets it (MICA-475)
// ---------------------------------------------------------------------------------------------

/**
 * A live page answers each `setVisible` show with `frameShown` once Svelte's flush has put that
 * device's frame in the document, and only while that frame is still the one up. That is what
 * `web/src/shell/state/frameShown.ts` does: `tick()`, then the frame's `data-device-frame` root
 * must be `isConnected`, with no wait on a paint. Every case runs against a live page unless it
 * sets `draws` false, for a page that threw at boot or never loaded.
 */
const page = { draws: true, shown: null as DeviceId | null };
/**
 * How long the model page takes to answer. The real answer follows the flush, well inside this;
 * any delay short of `FRAME_SHOWN_TIMEOUT_MS` would do. It is not zero, so the answer arrives
 * after the open's own synchronous steps, as a NUI callback does.
 */
const PAGE_DRAW_MS = 32;

function pageReceives(message: string): void {
  const { action, data } = JSON.parse(message) as {
    action: string;
    data: { device: DeviceId; visible: boolean };
  };
  if (action !== 'setVisible') return;
  const { device, visible } = data;
  if (visible) page.shown = device;
  else if (page.shown === device) page.shown = null;
  if (!visible || !page.draws) return;
  setTimeout(() => {
    if (page.draws && page.shown === device) nui('frameShown', { device });
  }, PAGE_DRAW_MS);
}

const failing = (name: string) => (): never => {
  throw new Error(`injected failure in ${name}`);
};

/**
 * What a releasing call releases, or null for any other call. A throw at one of these cannot
 * release its own part, so the close sweep holds it to releasing every other part instead.
 */
const releasedBy = (call: Call): 'focus' | 'keepInput' | 'shown' | null => {
  if (call.args[0] === false && call.name === 'SetNuiFocus') return 'focus';
  if (call.args[0] === false && call.name === 'SetNuiFocusKeepInput') return 'keepInput';
  const message = call.name === 'SendNuiMessage' ? String(call.args[0]) : '';
  return /"action":"setVisible".*"visible":false/.test(message) ? 'shown' : null;
};

// ---------------------------------------------------------------------------------------------
// What the player is left with
// ---------------------------------------------------------------------------------------------

interface Held {
  focus: boolean;
  keepInput: boolean;
  open: DeviceId | null;
  shown: DeviceId[];
}

/** Read from the calls since the last reset, which began with everything released. */
const held = (): Held => {
  const took = calls.filter((c) => !c.threw);
  const focus = last(took.filter((c) => c.name === 'SetNuiFocus'));
  const keep = last(took.filter((c) => c.name === 'SetNuiFocusKeepInput'));
  const visible = new Map<string, boolean>();
  for (const c of took) {
    if (c.name !== 'SendNuiMessage') continue;
    const message = JSON.parse(String(c.args[0])) as { action: string; data: any };
    if (message.action === 'setVisible') {
      visible.set(String(message.data.device), message.data.visible === true);
    }
  }
  return {
    focus: focus?.args[0] === true,
    keepInput: keep?.args[0] === true,
    open: DeviceState.openDevice(),
    shown: ALL_DEVICES.filter((d) => visible.get(d) === true)
  };
};

const RELEASED: Held = { focus: false, keepInput: false, open: null, shown: [] };

/** What is wrong with the state, or nothing: focus held exactly while a shown device is open. */
const inconsistency = (state: Held): string[] => {
  const problems: string[] = [];
  if (state.open === null) {
    if (state.focus) problems.push('NUI focus held with no device open');
    if (state.keepInput) problems.push('keep-input on with no device open');
    if (state.shown.length) problems.push(`frame shown with no device open: ${state.shown}`);
  } else {
    if (!state.focus) problems.push(`${state.open} open without NUI focus`);
    if (state.shown.join() !== state.open) {
      problems.push(`${state.open} open but frames shown: [${state.shown}]`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------------------------

const only = <T>(found: T[] | undefined, what: string): T => {
  if (found?.length !== 1) throw new Error(`${what}: ${found?.length ?? 0} handlers, not 1`);
  return found[0] as T;
};

const net =
  (event: string) =>
  (...args: unknown[]): unknown =>
    only(netHandlers.get(event), `onNet('${event}')`)(...args);

const exported =
  (name: string) =>
  (...args: unknown[]): unknown => {
    const fn = publishedClientExport(name);
    if (!fn) throw new Error(`no client export '${name}'`);
    return fn(...args);
  };

const nui = (name: string, data: unknown): unknown =>
  only(nuiHandlers.get(name), `on('__cfx_nui:${name}')`)(data, () => undefined);

const command = (name: string): unknown => {
  const handler = commands.get(name);
  if (!handler) throw new Error(`no command '${name}'`);
  return handler(0, [], '');
};

/** Run a driver as FiveM would: a throw is logged, and an export answers `internal_error`. */
const attempt = (drive: () => unknown): { threw: boolean } => {
  try {
    const result = drive() as { ok?: boolean; reason?: string } | undefined;
    if (result instanceof Promise) result.catch(() => undefined);
    return { threw: result?.ok === false && result.reason === 'internal_error' };
  } catch {
    return { threw: true };
  }
};

/** Past every load deadline (`DeviceAnimation`'s 2.5s) and the item check's coalescing. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(5_000).then(() => undefined);

const hideFrame = (): unknown => nui('hideFrame', {});

const reset = async (): Promise<void> => {
  throwAt = null;
  answers.clear();
  page.draws = true;
  closeOpenDevice();
  Freelook.resetFreelook();
  await settle();
  page.shown = null;
  DeviceState.__reset();
  // The tablet starts switched off until the server says otherwise (MICA-263).
  DeviceState.setServerEnabled('tablet', true);
  calls = [];
};

// ---------------------------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------------------------

interface OpenPath {
  devices: readonly DeviceId[];
  /** `device` raises a frame with `SetNuiFocus(true, true)`; `keepInput` is freelook. */
  takes: 'device' | 'keepInput';
  /** What has to be true first, which is not the step under test. */
  prepare?: (device: DeviceId) => unknown;
  /** Every path refuses a disabled device: see `GATES`. */
  open: (device: DeviceId) => unknown;
}

const PATHS: Record<string, OpenPath> = {
  'command:togglePhone': {
    devices: ['phone'],
    takes: 'device',
    open: () => command('togglePhone')
  },
  'command:toggleTablet': {
    devices: ['tablet'],
    takes: 'device',
    open: () => command('toggleTablet')
  },
  'export:OpenPhone': {
    devices: ALL_DEVICES,
    takes: 'device',
    open: (d) => exported('OpenPhone')(d)
  },
  'export:TogglePhone': {
    devices: ALL_DEVICES,
    takes: 'device',
    open: (d) => exported('TogglePhone')(d)
  },
  'export:OpenApp': {
    devices: ALL_DEVICES,
    takes: 'device',
    open: (d) => exported('OpenApp')('notes', {}, d)
  },
  'net:mica:client:shell:open': {
    devices: ALL_DEVICES,
    takes: 'device',
    open: (d) => net('mica:client:shell:open')({ device: d })
  },
  'net:mica:client:shell:openApp': {
    devices: ALL_DEVICES,
    takes: 'device',
    open: (d) => net('mica:client:shell:openApp')({ appId: 'notes', device: d })
  },
  // A disabled phone does not ring (MICA-467): it used to be raised for one, confiscated or not.
  'net:mica:client:phone:incoming': {
    devices: ['phone'],
    takes: 'device',
    open: () => net('mica:client:phone:incoming')({ from: '555-0100', callId: 1 })
  },
  'nui:toggleFreelook': {
    devices: ALL_DEVICES,
    takes: 'keepInput',
    prepare: (d) => exported('OpenPhone')(d),
    open: () => nui('toggleFreelook', { state: true })
  }
};

/** Registration sites whose name is an expression, resolved from the table the code reads. */
const DYNAMIC_SITES: Record<string, () => string[]> = {
  'command:DEVICES[id].keybind.command': () =>
    ALL_DEVICES.map((d) => `command:${DEVICES[d].keybind.command}`)
};

/**
 * How many async sites each path reaches, pinned. A new `await`, `.then`, `.catch` or `void`
 * anywhere an open path reaches changes one of these, and must arrive with its failure below.
 */
const ASYNC_SITE_COUNTS: Record<string, number> = {
  'command:DEVICES[id].keybind.command': 8,
  'export:OpenPhone': 8,
  'export:TogglePhone': 8,
  'export:OpenApp': 8,
  'net:mica:client:shell:open': 8,
  'net:mica:client:shell:openApp': 8,
  'net:mica:client:phone:incoming': 8,
  'nui:toggleFreelook': 0
};

const ANIM = 'client/game/DeviceAnimation.ts:DeviceAnimation';

interface AsyncFailure {
  label: string;
  /** Natives answered differently for the case. */
  answers: Record<string, (...args: unknown[]) => unknown>;
  /** The native whose call proves the failure was reached at all. */
  reached: string;
}

/** For each async site an open path reaches, what happens when that step goes wrong. */
const ASYNC_FAILURES: Record<string, AsyncFailure[]> = {
  // The open does not wait for the pose; the pose throwing as it starts must not reach it.
  'client/lib/DeviceVisibility.ts:openDevice#void1': [
    {
      label: 'the idle animation throws as it starts',
      answers: { RequestAnimDict: failing('RequestAnimDict') },
      reached: 'RequestAnimDict'
    }
  ],
  [`${ANIM}.playIdle#catch1`]: [
    {
      label: 'the idle animation rejects once loaded',
      answers: { TaskPlayAnim: failing('TaskPlayAnim') },
      reached: 'TaskPlayAnim'
    }
  ],
  [`${ANIM}.play#await1`]: [
    {
      label: 'the animation dictionary is reported missing and never arrives',
      answers: { DoesAnimDictExist: () => false, HasAnimDictLoaded: () => false },
      reached: 'DoesAnimDictExist'
    }
  ],
  [`${ANIM}.loadAnimDict#await1`]: [
    {
      label: 'the animation dictionary never loads',
      answers: { HasAnimDictLoaded: () => false },
      reached: 'HasAnimDictLoaded'
    }
  ],
  [`${ANIM}.loadModel#await1`]: [
    {
      label: 'the prop model never loads',
      answers: { HasModelLoaded: () => false },
      reached: 'HasModelLoaded'
    }
  ],
  [`${ANIM}.spawnProp#void1`]: [
    {
      label: 'the prop model is not valid',
      answers: { IsModelValid: () => false },
      reached: 'IsModelValid'
    }
  ],
  [`${ANIM}.spawnProp#then1`]: [
    {
      label: 'the prop fails to spawn',
      answers: { CreateObject: failing('CreateObject') },
      reached: 'CreateObject'
    }
  ],
  [`${ANIM}.spawnProp#catch1`]: [
    {
      label: 'the prop fails to attach',
      answers: { AttachEntityToEntity: failing('AttachEntityToEntity') },
      reached: 'AttachEntityToEntity'
    }
  ]
};

/** Every way a device goes down, each tried against every open. */
const CLOSES: Record<string, (device: DeviceId) => unknown> = {
  'nui:hideFrame': () => hideFrame(),
  'command (the same key)': (d) => command(DEVICES[d].keybind.command),
  'export:ClosePhone': (d) => exported('ClosePhone')(d),
  'export:TogglePhone': (d) => exported('TogglePhone')(d),
  'export:SetPhoneEnabled(false)': (d) => exported('SetPhoneEnabled')(false, d),
  'net:mica:client:shell:setEnabled': (d) =>
    net('mica:client:shell:setEnabled')({ device: d, enabled: false }),
  'net:mica:client:shell:setServerEnabled': (d) =>
    net('mica:client:shell:setServerEnabled')({ device: d, enabled: false }),
  'net:mica:client:shell:phoneItem': (d) =>
    net('mica:client:shell:phoneItem')({ device: d, gated: true, held: false })
};

/** Each way the server, or a script, keeps a device shut. */
const GATES: Record<string, (device: DeviceId) => unknown> = {
  'confiscated (SetPhoneEnabled false)': (d) => exported('SetPhoneEnabled')(false, d),
  'switched off by the server': (d) =>
    net('mica:client:shell:setServerEnabled')({ device: d, enabled: false }),
  'the item is not held': (d) =>
    net('mica:client:shell:phoneItem')({ device: d, gated: true, held: false })
};

const cases = Object.entries(PATHS).flatMap(([id, path]) =>
  path.devices.map((device) => ({ id, path, device, label: `${id} (${device})` }))
);

/** Run a path's prepare and open, and answer the index its own calls began at. */
const openFresh = async (
  path: OpenPath,
  device: DeviceId
): Promise<{ start: number; threw: boolean }> => {
  if (path.prepare) {
    path.prepare(device);
    await settle();
  }
  const start = calls.length;
  const { threw } = attempt(() => path.open(device));
  return { start, threw };
};

/** Did the path do what it is for: a device up, or keep-input on. */
const tookFocus = (path: OpenPath, device: DeviceId): boolean => {
  const state = held();
  return path.takes === 'device'
    ? state.open === device && state.focus && state.shown.join() === device
    : state.open === device && state.keepInput;
};

// ---------------------------------------------------------------------------------------------

beforeAll(() => {
  vi.useFakeTimers();
  // Every injected throw is logged by the code that catches it, which is the behaviour wanted
  // and several hundred lines of noise here.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the census of paths that take NUI focus', () => {
  const graph = new SourceGraph();
  const takers = graph.focusTakers();
  const openSites = graph
    .registrations()
    .filter((r) => [...graph.reach(r.id)].some((n) => takers.has(n)));
  const expanded = (id: string): string[] => DYNAMIC_SITES[id]?.() ?? [id];

  it('reads every focus call in client/ as a literal', () => {
    expect(graph.unreadable).toEqual([]);
    expect(graph.focusCalls.length).toBeGreaterThan(0);
  });

  it('finds every open path in the source, and each is driven here', () => {
    const unresolved = openSites
      .filter((r) => !r.registration?.literal && !DYNAMIC_SITES[r.id])
      .map((r) => r.id);
    expect(unresolved).toEqual([]);
    expect(sorted(openSites.flatMap((r) => expanded(r.id)))).toEqual(sorted(Object.keys(PATHS)));
  });

  it('places every focus-taking function under a registration, none at module scope', () => {
    const reachedByRegistration = new Set(
      graph.registrations().flatMap((r) => [...graph.reach(r.id)])
    );
    expect([...takers].filter((t) => !reachedByRegistration.has(t))).toEqual([]);
    const reachesFocus = (id: string): boolean =>
      [...graph.reach(id, { intoRegistrations: false })].some((n) => takers.has(n));
    expect(graph.moduleRefs.filter((ref) => reachesFocus(ref.target))).toEqual([]);
  });

  it('pins the async sites each open path reaches, and every one has a failure to inject', () => {
    const counts = Object.fromEntries(
      openSites.map((r) => [r.id, graph.sitesReachedFrom(r.id).length])
    );
    expect(counts).toEqual(ASYNC_SITE_COUNTS);
    const reached = new Set(openSites.flatMap((r) => graph.sitesReachedFrom(r.id)));
    expect(sorted([...reached])).toEqual(sorted(Object.keys(ASYNC_FAILURES)));
  });

  it('agrees with the load: exactly these registrations take focus when driven', async () => {
    const PAYLOADS: unknown[][] = [
      [],
      [undefined],
      ['phone'],
      ['tablet'],
      [true],
      [{ device: 'phone' }],
      [{ device: 'tablet' }],
      [{ appId: 'notes' }],
      [{ appId: 'notes', device: 'tablet' }],
      [{ from: '555-0100', callId: 1 }],
      [{ state: true }],
      [{ state: false }],
      ['notes'],
      ['notes', {}, 'tablet']
    ];
    const drivers: [string, (args: unknown[]) => unknown][] = [
      ...[...netHandlers.entries()].flatMap(([event, handlers]) =>
        handlers.map((h) => [`net:${event}`, (args: unknown[]) => h(...args)] as [string, typeof h])
      ),
      ...[...commands.entries()].map(
        ([name, h]) => [`command:${name}`, () => h(0, [], '')] as [string, typeof h]
      ),
      ...publishedClientExports().map(
        (name) =>
          [`export:${name}`, (args: unknown[]) => exported(name)(...args)] as [
            string,
            (args: unknown[]) => unknown
          ]
      ),
      ...[...nuiHandlers.entries()].flatMap(([name, handlers]) =>
        handlers.map(
          (h) =>
            [`nui:${name}`, (args: unknown[]) => h(args[0], () => undefined)] as [
              string,
              (args: unknown[]) => unknown
            ]
        )
      )
    ];
    const took = new Set<string>();
    for (const [id, drive] of drivers) {
      for (const upFirst of [false, true]) {
        for (const args of PAYLOADS) {
          await reset();
          if (upFirst) exported('OpenPhone')('phone');
          const start = calls.length;
          attempt(() => drive(args));
          await settle();
          const taking = calls
            .slice(start)
            .some(
              (c) =>
                !c.threw &&
                (c.name === 'SetNuiFocus' || c.name === 'SetNuiFocusKeepInput') &&
                c.args[0] === true
            );
          if (taking) took.add(id);
        }
      }
    }
    await reset();
    expect(sorted([...took])).toEqual(sorted(Object.keys(PATHS)));
  });
});

describe.each(cases)('$label', ({ path, device }) => {
  it('opens, and each close route leaves everything released', async () => {
    for (const [close, drive] of Object.entries(CLOSES)) {
      await reset();
      await openFresh(path, device);
      await settle();
      expect(tookFocus(path, device), `${close}: the happy run took focus`).toBe(true);
      expect(inconsistency(held()), close).toEqual([]);
      attempt(() => drive(device));
      await settle();
      expect({ close, ...held() }).toEqual({ close, ...RELEASED });
    }
  });

  it('survives a throw at each native it calls, one at a time', async () => {
    await reset();
    const { start } = await openFresh(path, device);
    // The open and what it starts without waiting on a timer: the pose and the prop, whose
    // loads answer at once here. Not the status-bar clock's later ticks, which take no focus.
    await vi.advanceTimersByTimeAsync(0);
    const steps = calls.slice(start).map((c) => c.name);
    await settle();
    expect(tookFocus(path, device), 'the happy run took focus').toBe(true);
    // The sweep reaches the call that takes focus, so a throw there is one of its cases.
    expect(steps).toContain(path.takes === 'device' ? 'SetNuiFocus' : 'SetNuiFocusKeepInput');

    const problems: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      await reset();
      const before = await (async () => {
        if (path.prepare) {
          path.prepare(device);
          await settle();
        }
        return calls.length;
      })();
      throwAt = before + i;
      attempt(() => path.open(device));
      await settle();
      const where = `throw at step ${i} (${steps[i]})`;
      if (throwAt !== null) problems.push(`${where}: never reached; the run is not deterministic`);
      for (const p of inconsistency(held())) problems.push(`${where}: ${p}`);
      attempt(hideFrame);
      await settle();
      const after = held();
      if (JSON.stringify(after) !== JSON.stringify(RELEASED)) {
        problems.push(`${where}, then hideFrame: ${JSON.stringify(after)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  if (path.takes === 'device') {
    it.each(
      Object.entries(ASYNC_FAILURES).flatMap(([site, failures]) =>
        failures.map((f) => ({ site, ...f }))
      )
    )('$label ($site)', async (failure) => {
      for (const closeEarly of [false, true]) {
        await reset();
        for (const [name, answer] of Object.entries(failure.answers)) answers.set(name, answer);
        await openFresh(path, device);
        const label = closeEarly ? 'closed mid-flight' : 'left to finish';
        if (closeEarly) {
          attempt(hideFrame);
          const closedAt = calls.length;
          await settle();
          expect(held(), label).toEqual(RELEASED);
          // Nothing the open started lands in the hand after the device is down.
          const late = calls.slice(closedAt).filter((c) => !c.threw && c.name === 'CreateObject');
          expect(late, label).toEqual([]);
        } else {
          await settle();
          expect(
            calls.some((c) => c.name === failure.reached),
            `${label}: ${failure.reached} was reached`
          ).toBe(true);
          expect(inconsistency(held()), label).toEqual([]);
          expect(tookFocus(path, device), `${label}: the device is still up and usable`).toBe(true);
          attempt(hideFrame);
          await settle();
          expect(held(), label).toEqual(RELEASED);
        }
      }
    });

    it.each(Object.keys(GATES))('when %s', async (gate) => {
      await reset();
      (GATES[gate] as (d: DeviceId) => unknown)(device);
      await openFresh(path, device);
      await settle();
      expect(held()).toEqual(RELEASED);
    });
  }
});

describe.each(
  ALL_DEVICES.flatMap((device) => Object.keys(CLOSES).map((close) => ({ device, close })))
)('closing $device by $close', ({ device, close }) => {
  it('releases even when a step of the close throws, a releasing one included', async () => {
    const drive = CLOSES[close] as (d: DeviceId) => unknown;
    await reset();
    exported('OpenPhone')(device);
    nui('toggleFreelook', { state: true });
    await settle();
    expect(held()).toMatchObject({ focus: true, keepInput: true, open: device });
    const start = calls.length;
    attempt(() => drive(device));
    await settle();
    expect(held()).toEqual(RELEASED);
    const steps = calls.slice(start);
    // The sweep reaches all three releases, so each is one of its cases.
    expect(sorted(steps.map(releasedBy).filter((r) => r !== null))).toEqual([
      'focus',
      'keepInput',
      'shown'
    ]);

    const problems: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const spared = releasedBy(steps[i] as Call);
      await reset();
      exported('OpenPhone')(device);
      nui('toggleFreelook', { state: true });
      await settle();
      throwAt = calls.length + i;
      attempt(() => drive(device));
      await settle();
      const where = `throw at step ${i} (${steps[i]?.name})`;
      if (throwAt !== null) problems.push(`${where}: never reached; the run is not deterministic`);
      const after = held();
      const expected = spared ? { ...RELEASED, [spared]: after[spared] } : RELEASED;
      if (JSON.stringify(after) !== JSON.stringify(expected)) {
        problems.push(`${where}: ${JSON.stringify(after)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the page is always answered when it asks to close', () => {
  it.each(ALL_DEVICES)('hideFrame calls back once even when closing the %s throws', async (d) => {
    await reset();
    exported('OpenPhone')(d);
    await settle();
    answers.set('TriggerServerEvent', failing('TriggerServerEvent'));
    let answered = 0;
    let threw = false;
    try {
      only(nuiHandlers.get('hideFrame'), "on('__cfx_nui:hideFrame')")({}, () => {
        answered++;
      });
    } catch {
      threw = true;
    }
    // Still released, still reported, and the page's `fetchNui('hideFrame')` resolves.
    expect({ answered, threw, ...held() }).toEqual({ answered: 1, threw: true, ...RELEASED });
  });
});

/**
 * Each close that does not come from the page, and what undoes it. `hideFrame` clears
 * `isTyping` itself; these are the closes that used to leave it set (MICA-467).
 */
const FORCED: Record<string, { close: (d: DeviceId) => unknown; undo: (d: DeviceId) => unknown }> =
  {
    'export:ClosePhone': { close: (d) => exported('ClosePhone')(d), undo: () => undefined },
    'export:SetPhoneEnabled': {
      close: (d) => exported('SetPhoneEnabled')(false, d),
      undo: (d) => exported('SetPhoneEnabled')(true, d)
    },
    'net:mica:client:shell:setEnabled': {
      close: (d) => net('mica:client:shell:setEnabled')({ device: d, enabled: false }),
      undo: (d) => net('mica:client:shell:setEnabled')({ device: d, enabled: true })
    },
    'net:mica:client:shell:setServerEnabled': {
      close: (d) => net('mica:client:shell:setServerEnabled')({ device: d, enabled: false }),
      undo: (d) => net('mica:client:shell:setServerEnabled')({ device: d, enabled: true })
    },
    'net:mica:client:shell:phoneItem': {
      close: (d) => net('mica:client:shell:phoneItem')({ device: d, gated: true, held: false }),
      undo: (d) => net('mica:client:shell:phoneItem')({ device: d, gated: true, held: true })
    }
  };

describe.each(
  ALL_DEVICES.flatMap((device) => Object.keys(FORCED).map((close) => ({ device, close })))
)('a forced close of the $device by $close while a text field has focus', ({ device, close }) => {
  it('leaves the key able to raise it again', async () => {
    const { close: force, undo } = FORCED[close] as (typeof FORCED)[string];
    await reset();
    command(DEVICES[device].keybind.command);
    nui('setTyping', { typing: true });
    attempt(() => force(device));
    undo(device);
    await settle();
    expect(held()).toEqual(RELEASED);
    command(DEVICES[device].keybind.command);
    await settle();
    expect(held()).toMatchObject({ focus: true, open: device, shown: [device] });
    expect(DeviceState.isTyping(), 'a field in a frame that went down is no longer typing').toBe(
      false
    );
  });
});

describe('what opens nothing', () => {
  it.each(ALL_DEVICES)('SetPhoneEnabled(true) on a closed %s takes no focus', async (device) => {
    await reset();
    exported('SetPhoneEnabled')(false, device);
    exported('SetPhoneEnabled')(true, device);
    await settle();
    expect(held()).toEqual(RELEASED);
  });

  it.each(ALL_DEVICES)('toggling freelook off keeps the %s up, with keep-input off', async (d) => {
    await reset();
    exported('OpenPhone')(d);
    nui('toggleFreelook', { state: true });
    nui('toggleFreelook', { state: false });
    await settle();
    expect(held()).toEqual({ focus: true, keepInput: false, open: d, shown: [d] });
    attempt(hideFrame);
    expect(held()).toEqual(RELEASED);
  });
});

/**
 * A page that never draws the frame (MICA-475). This was a known gap: the open took focus, sent
 * `setVisible`, and awaited nothing from the page, so a page that threw at boot or never loaded
 * left the player's every key going to a frame that was not there, until a push or an export
 * closed it. Now the open waits for the page's `frameShown`, and at `FRAME_SHOWN_TIMEOUT_MS`
 * without it, puts the device down through the every-step close.
 */
describe('a page that never draws the frame (MICA-475)', () => {
  it.each(cases)('releases $label at the deadline', async ({ path, device }) => {
    await reset();
    page.draws = false;
    await openFresh(path, device);
    await vi.advanceTimersByTimeAsync(0);
    expect(tookFocus(path, device), 'the open took focus').toBe(true);
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
    expect(held()).toEqual(RELEASED);
  });

  it.each(ALL_DEVICES)('holds the %s up to the deadline and not past it', async (device) => {
    await reset();
    page.draws = false;
    exported('OpenPhone')(device);
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS - 1);
    expect(held()).toEqual({ focus: true, keepInput: false, open: device, shown: [device] });
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(held()).toEqual(RELEASED);
    // The server's half: `PhoneOpenState` is told the device went down.
    const told = calls.slice(before).filter((c) => c.name === 'TriggerServerEvent');
    expect(told.map((c) => c.args)).toContainEqual([
      'mica:server:shell:setOpen',
      { device, open: false }
    ]);
  });

  it.each(ALL_DEVICES)('keeps the %s up when the page draws it', async (device) => {
    await reset();
    exported('OpenPhone')(device);
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS * 4);
    expect(held()).toEqual({ focus: true, keepInput: false, open: device, shown: [device] });
    attempt(hideFrame);
    expect(held()).toEqual(RELEASED);
  });

  it('ignores a late answer for one device while the other waits', async () => {
    // The phone's page never answered and its deadline put it down. The tablet is raised next,
    // and its page never answers either. The phone's answer arriving now must not cancel the
    // tablet's deadline.
    await reset();
    page.draws = false;
    exported('OpenPhone')('phone');
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
    expect(held()).toEqual(RELEASED);
    exported('OpenPhone')('tablet');
    nui('frameShown', { device: 'phone' });
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
    expect(held()).toEqual(RELEASED);
  });

  it.each(ALL_DEVICES)(
    'takes nothing from a late answer after the %s went down, and the reopen still waits',
    async (device) => {
      await reset();
      page.draws = false;
      exported('OpenPhone')(device);
      await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
      const after = calls.length;
      nui('frameShown', { device });
      await settle();
      expect(held()).toEqual(RELEASED);
      expect(calls.slice(after), 'the late answer did nothing').toEqual([]);
      exported('OpenPhone')(device);
      await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
      expect(held()).toEqual(RELEASED);
    }
  );

  it.each(ALL_DEVICES)('ignores an answer that does not name the %s', async (device) => {
    const other = ALL_DEVICES.find((d) => d !== device);
    await reset();
    page.draws = false;
    exported('OpenPhone')(device);
    // The other device, a wrong case, and nothing a device id can be. The page is untrusted.
    for (const named of [other, device.toUpperCase(), undefined, null, 1, {}, [device]]) {
      nui('frameShown', { device: named });
    }
    nui('frameShown', device);
    nui('frameShown', null);
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
    expect(held()).toEqual(RELEASED);
  });

  it.each(ALL_DEVICES)('cancels the deadline when the %s is closed first', async (device) => {
    await reset();
    page.draws = false;
    exported('OpenPhone')(device);
    await vi.advanceTimersByTimeAsync(1_000);
    attempt(hideFrame);
    const closedAt = calls.length;
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS);
    expect(held()).toEqual(RELEASED);
    // Nothing runs at the old deadline: no second close of a device already down.
    expect(calls.slice(closedAt).map((c) => c.name)).toEqual([]);
  });

  it.each(ALL_DEVICES)('gives a reopen of the %s a deadline of its own', async (device) => {
    await reset();
    page.draws = false;
    exported('OpenPhone')(device);
    await vi.advanceTimersByTimeAsync(1_000);
    attempt(hideFrame);
    exported('OpenPhone')(device);
    // The first open's deadline passes with the reopen still waiting on its own.
    await vi.advanceTimersByTimeAsync(FRAME_SHOWN_TIMEOUT_MS - 1_000);
    expect(held()).toEqual({ focus: true, keepInput: false, open: device, shown: [device] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held()).toEqual(RELEASED);
  });
});
