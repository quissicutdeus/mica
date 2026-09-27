// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-247. What an app, and a sandboxed add-on, may do to the control center through
 * `useControlCenter` — driven through the real in-process facet into the shell's own
 * `controlCenter.ts` state, because the facet is where every check lives and a stubbed
 * facet would prove only that the hook forwards.
 *
 * In-process facets, because a unit test stands in for the shell (MICA-176). The add-on
 * half stands in for a frame by posting the raw messages its twin would send — and the
 * ones its twin would not, which is the point of the impersonation test.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { useControlCenter } from './useControlCenter';
import { AppPermissionError } from './protocol';
import { registerHost, resetHostsForTest } from './current';
import { createInProcessHost } from './inProcess/createInProcessHost';
import { defineApp, type AppPermission } from '../manifest';
import { orderedToggles } from '../../web/src/shell/state/controlCenter';
import { MAX_TOGGLES_PER_APP } from '../../web/src/host/facets/controlCenter';
import { createIframeHostServer } from '../../web/src/shell/addon/IframeHostServer';
import { recordConsent, resetGrantsForTest } from '../../web/src/shell/state/addOnGrants';
import { __resetSettingsSync } from '../../web/src/host/settingsSync';
import type { ToFrame } from './iframe/messages';

/** The contributed switches the shell would draw, as `<appId>:<id>` → label. */
const contributed = () =>
  Object.fromEntries(
    get(orderedToggles)
      .filter((t) => !t.builtin)
      .map((t) => [t.key, { label: t.label, icon: t.icon, active: t.active }])
  );
const tap = (key: string) =>
  get(orderedToggles)
    .find((t) => t.key === key)
    ?.onToggle();

const toggle = (id: string, onToggle = vi.fn()) => ({
  id,
  label: `Label ${id}`,
  icon: 'MoonIcon',
  active: false,
  onToggle
});

const releases: (() => void)[] = [];

beforeEach(() => {
  resetHostsForTest();
  resetGrantsForTest();
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  __resetSettingsSync();
});

describe('useControlCenter — a core app', () => {
  const app = (id: string, permissions: AppPermission[]) => {
    registerHost(createInProcessHost(id, permissions));
    return useControlCenter(id);
  };

  it('puts a switch up under its own id, runs its handler on a tap, and takes it down', () => {
    const cc = app('radio', ['control-center']);
    const onToggle = vi.fn();
    const off = cc.registerToggle(toggle('scanner', onToggle));
    releases.push(off);

    expect(contributed()).toEqual({
      'radio:scanner': { label: 'Label scanner', icon: 'MoonIcon', active: false }
    });

    tap('radio:scanner');
    expect(onToggle).toHaveBeenCalledTimes(1);
    // A tap changes nothing on its own; the switch shows what the app reports.
    expect(contributed()['radio:scanner'].active).toBe(false);
    cc.setToggleActive('scanner', true);
    expect(contributed()['radio:scanner'].active).toBe(true);

    off();
    expect(contributed()).toEqual({});
  });

  it('is refused without the control-center permission', () => {
    registerHost(createInProcessHost('radio', ['storage']));
    expect(() => useControlCenter('radio')).toThrow(AppPermissionError);
    expect(contributed()).toEqual({});
  });

  it('refuses a switch it cannot draw', () => {
    const cc = app('radio', ['control-center']);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => cc.registerToggle({ ...toggle('a'), icon: 'NotAnIcon' })).toThrow(/icon/);
    expect(() => cc.registerToggle({ ...toggle('a'), icon: 'toString' })).toThrow(/icon/);
    expect(() => cc.registerToggle({ ...toggle('a'), label: 'x'.repeat(33) })).toThrow(/label/);
    expect(() => cc.registerToggle({ ...toggle('a'), label: '   ' })).toThrow(/label/);
    expect(() => cc.registerToggle(toggle('has:colon'))).toThrow(/id/);
    expect(() => cc.registerToggle(toggle('x'.repeat(33)))).toThrow(/id/);
    quiet.mockRestore();
    expect(contributed()).toEqual({});
  });

  it(`holds at most ${MAX_TOGGLES_PER_APP} per app, and a repeated id replaces rather than counts`, () => {
    const cc = app('radio', ['control-center']);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < MAX_TOGGLES_PER_APP; i++) releases.push(cc.registerToggle(toggle(`t${i}`)));
    releases.push(cc.registerToggle({ ...toggle('t0'), label: 'Renamed' }));
    expect(() => cc.registerToggle(toggle('one-too-many'))).toThrow(/at most/);
    quiet.mockRestore();
    expect(Object.keys(contributed())).toHaveLength(MAX_TOGGLES_PER_APP);
    expect(contributed()['radio:t0'].label).toBe('Renamed');
  });

  it("cannot reach another app's switch by id", () => {
    const radio = app('radio', ['control-center']);
    const other = app('other', ['control-center']);
    releases.push(radio.registerToggle(toggle('scanner')));
    other.setToggleActive('scanner', true);
    other.registerToggle(toggle('scanner'))();
    expect(contributed()['radio:scanner']).toEqual({
      label: 'Label scanner',
      icon: 'MoonIcon',
      active: false
    });
  });
});

describe('useControlCenter — a sandboxed add-on', () => {
  function frame(permissions: AppPermission[], granted = permissions) {
    const manifest = defineApp({
      id: 'probe',
      name: 'Probe',
      icon: 'x',
      tile: { bg: 'bg-gray-900' },
      core: false,
      permissions
    });
    recordConsent('probe', granted);
    const posted: ToFrame[] = [];
    const guest = { postMessage: (m: ToFrame) => posted.push(m) };
    const server = createIframeHostServer({
      host: createInProcessHost('probe', permissions),
      manifest,
      props: {},
      guest: () => guest,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    releases.push(() => server.dispose());
    const send = (data: unknown) =>
      server.handle({ data, source: guest, origin: 'null' } as unknown as MessageEvent);
    let nextId = 1;
    /** What the frame's twin sends, with whatever app id the frame chooses to claim. */
    const lease = (claimed = 'probe') =>
      send({
        kind: 'subscribe',
        id: nextId++,
        facet: 'controlCenter',
        factoryArgs: [claimed],
        member: 'lease'
      });
    const register = (id: string, claimed = 'probe', cb = 7) => {
      const callId = nextId++;
      send({
        kind: 'call',
        id: callId,
        facet: 'controlCenter',
        factoryArgs: [claimed],
        member: 'registerToggle',
        args: [{ ...toggle(id), onToggle: { __cb: cb } }]
      });
      return callId;
    };
    /** The reply the shell posted to one call, once it has settled. */
    const reply = async (callId: number) => {
      await new Promise((r) => setTimeout(r, 0));
      return posted.find((m) => m.kind === 'reply' && m.id === callId) as
        Extract<ToFrame, { kind: 'reply' }> | undefined;
    };
    return { server, posted, lease, register, reply };
  }

  it('registers under the frame, and a tap is posted back into the frame as its callback', async () => {
    const f = frame(['control-center']);
    f.lease();
    expect((await f.reply(f.register('scanner', 'probe', 11)))?.ok).toBe(true);
    expect(Object.keys(contributed())).toEqual(['probe:scanner']);

    tap('probe:scanner');
    expect(f.posted).toContainEqual({ kind: 'callback', cb: 11, args: [] });
  });

  it('is refused without the permission declared, and without it granted', async () => {
    const undeclared = frame(['storage']);
    undeclared.lease();
    const refused = await undeclared.reply(undeclared.register('scanner'));
    expect(refused?.ok).toBe(false);

    resetGrantsForTest();
    const ungranted = frame(['control-center'], []);
    ungranted.lease();
    const alsoRefused = await ungranted.reply(ungranted.register('scanner'));
    expect(alsoRefused?.ok).toBe(false);
    expect(contributed()).toEqual({});
  });

  it('cannot put a switch up under another app, or touch one', async () => {
    registerHost(createInProcessHost('bank', ['control-center']));
    const bank = useControlCenter('bank');
    releases.push(bank.registerToggle(toggle('scanner')));

    const f = frame(['control-center']);
    f.lease('bank');
    expect((await f.reply(f.register('scanner', 'bank')))?.ok).toBe(true);

    // The claimed id was replaced by the frame's own before the facet was built.
    expect(Object.keys(contributed()).sort()).toEqual(['bank:scanner', 'probe:scanner']);
    expect(contributed()['bank:scanner'].label).toBe('Label scanner');
  });

  it('is refused a switch it holds no lease for, since nothing could take it down', async () => {
    const f = frame(['control-center']);
    expect((await f.reply(f.register('scanner')))?.ok).toBe(false);
    expect(contributed()).toEqual({});
  });

  it("takes every one of the frame's switches down when the frame goes away", async () => {
    const f = frame(['control-center']);
    f.lease();
    await f.reply(f.register('a', 'probe', 1));
    await f.reply(f.register('b', 'probe', 2));
    expect(Object.keys(contributed())).toEqual(['probe:a', 'probe:b']);

    f.server.dispose();
    expect(contributed()).toEqual({});
  });
});
