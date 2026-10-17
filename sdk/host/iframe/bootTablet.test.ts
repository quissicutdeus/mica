// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { bootAddOn } from './boot';
import { resetHostsForTest } from '../current';
import { createClientTransport, setClientTransport } from './transport';
import UsesContacts from '../__fixtures__/UsesContacts.svelte';
import PropsProbe from '../__fixtures__/PropsProbe.svelte';
import type { AppManifest } from '../../manifest';
import type { HydratePayload, ToShell } from './messages';

/**
 * MICA-265: `bootAddOn` handed a tablet root.
 *
 * `UsesContacts` stands in for the phone root ("uses contacts") and `PropsProbe` for the
 * tablet root (its `label` prop, or "none"), so each assertion can say which one is on
 * screen by its text. The device arrives the way it does in the real frame: a `subscribe`
 * to `display.device`, answered by a `push` from the shell.
 *
 * Its own file for the reason `bootWidget.test.ts` gives: every boot leaves listeners on the
 * shared jsdom `window`, so each test removes what it added and gets a fresh transport.
 */

const manifest: AppManifest = {
  id: 'two_roots',
  name: 'Two Roots',
  color: 'bg-indigo-600',
  tile: { bg: 'bg-indigo-600' },
  icon: null,
  core: false,
  permissions: ['contacts', 'display'],
  devices: ['phone', 'tablet']
};

const payload: HydratePayload = {
  appId: 'two_roots',
  permissions: ['contacts', 'display'],
  props: {},
  theme: '--color-bg: #000;',
  storage: {},
  constants: {
    display: {},
    wallpaper: { presets: [], defaultWallpaper: null },
    systemHardware: { volumeStepChoices: [] },
    theme: { defaultTheme: null },
    clock: { is24Hour: false }
  }
};

async function boot(hydrate: HydratePayload, roots: Parameters<typeof bootAddOn>[2]) {
  const sent: ToShell[] = [];
  const parent = { postMessage: (msg: ToShell) => sent.push(msg) };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  setClientTransport(createClientTransport());
  const target = document.createElement('div');
  target.id = 'app';
  document.body.appendChild(target);

  const done = bootAddOn(manifest, UsesContacts, roots);
  const fromShell = (data: unknown) =>
    window.dispatchEvent(
      new MessageEvent('message', { data, source: parent as unknown as Window })
    );
  fromShell({ kind: 'hydrate', payload: hydrate });
  await done;

  const deviceWire = () =>
    sent.find(
      (m): m is Extract<ToShell, { kind: 'subscribe' }> =>
        m.kind === 'subscribe' && m.facet === 'display' && m.member === 'device'
    );
  /** The shell's answer on `display.device`, as `IframeHostServer` posts it. */
  const pushDevice = (device: string) => {
    const wire = deviceWire();
    if (!wire) throw new Error('the frame never subscribed to display.device');
    fromShell({ kind: 'push', id: wire.id, value: device });
    flushSync();
  };
  return { sent, fromShell, deviceWire, pushDevice };
}

const screen = () => document.body.textContent ?? '';

let added: Parameters<typeof window.addEventListener>[] = [];
beforeEach(() => {
  added = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (...args: Parameters<typeof window.addEventListener>) => {
      added.push(args);
      add(...args);
    }
  );
});

afterEach(() => {
  for (const [type, listener, options] of added) {
    window.removeEventListener(type, listener, options);
  }
  resetHostsForTest();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bootAddOn with a tablet root (MICA-265)', () => {
  it('mounts nothing until the shell says which device it is on', async () => {
    // Mounting the phone root on the seed and swapping a round trip later would run its
    // foreground load for nothing on every tablet open.
    const { deviceWire } = await boot(payload, { tablet: PropsProbe });

    expect(deviceWire()).toMatchObject({ facet: 'display', factoryArgs: [], member: 'device' });
    expect(screen()).toBe('');
  });

  it('mounts the tablet root, and not the app, when the device is the tablet', async () => {
    const { pushDevice } = await boot(payload, { tablet: PropsProbe });
    pushDevice('tablet');

    expect(screen()).toContain('none');
    expect(screen()).not.toContain('uses contacts');
  });

  it('mounts the app, and not the tablet root, when the device is the phone', async () => {
    const { pushDevice } = await boot(payload, { tablet: PropsProbe });
    pushDevice('phone');

    expect(screen()).toContain('uses contacts');
    expect(screen()).not.toContain('none');
  });

  it('swaps roots when the device changes under a running frame', async () => {
    const { pushDevice } = await boot(payload, { tablet: PropsProbe });
    pushDevice('tablet');
    pushDevice('phone');
    expect(screen()).toBe('uses contacts');

    pushDevice('tablet');
    expect(screen()).toBe('none');
  });

  it('gives the tablet root the same deep-link props the app would get', async () => {
    const { pushDevice, fromShell } = await boot(
      { ...payload, props: { label: 'opened by a link' } },
      { tablet: PropsProbe }
    );
    pushDevice('tablet');
    expect(screen()).toContain('opened by a link');

    fromShell({ kind: 'props', props: { label: 'a second link' } });
    flushSync();
    expect(screen()).toContain('a second link');
  });

  it("draws the app everywhere, and never asks, when 'display' was not granted", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deviceWire } = await boot(
      { ...payload, permissions: ['contacts'] },
      { tablet: PropsProbe }
    );

    expect(deviceWire()).toBeUndefined();
    expect(screen()).toContain('uses contacts');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no 'display' permission/));
  });

  it('draws the app if the shell never answers, and still follows a late answer', async () => {
    // A shell older than `display.device` (MICA-260) refuses the subscription without a
    // reply; a blank frame forever would be worse than the phone root on a tablet.
    vi.useFakeTimers();
    const { pushDevice } = await boot(payload, { tablet: PropsProbe });
    expect(screen()).toBe('');

    vi.advanceTimersByTime(999);
    expect(screen()).toBe('');
    vi.advanceTimersByTime(1);
    flushSync();
    expect(screen()).toContain('uses contacts');

    pushDevice('tablet');
    expect(screen()).toBe('none');
  });

  it('subscribes to nothing new for a bundle that passed no tablet root', async () => {
    const { deviceWire } = await boot(payload, {});

    expect(deviceWire()).toBeUndefined();
    expect(screen()).toContain('uses contacts');
  });
});
