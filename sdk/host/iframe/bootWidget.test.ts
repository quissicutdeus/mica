// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { bootAddOn } from './boot';
import { hostFor, resetHostsForTest } from '../current';
import { createClientTransport, setClientTransport } from './transport';
import UsesContacts from '../__fixtures__/UsesContacts.svelte';
import WidgetProbe from '../__fixtures__/WidgetProbe.svelte';
import type { AppManifest } from '../../manifest';
import type { HydratePayload, ToShell } from './messages';

/**
 * MICA-245: `bootAddOn` in a frame the shell booted as a widget.
 *
 * Its own file rather than a block in `boot.test.ts`, because what it asserts about keys
 * cannot hold there: every app-mode boot in that file leaves its `keydown` forwarder on the
 * shared jsdom `window`, and each one posts to whatever `window.parent` is stubbed next. A
 * fresh transport per test (below) keeps each boot's `hydrated()` its own for the same
 * reason — the module-level one resolves once and stays resolved.
 */

const manifest: AppManifest = {
  id: 'uses_contacts',
  name: 'Uses Contacts',
  color: 'bg-indigo-600',
  tile: { bg: 'bg-indigo-600' },
  icon: null,
  core: false,
  permissions: ['contacts'],
  widget: { sizes: ['2x1', '2x2'] }
};

const appPayload: HydratePayload = {
  appId: 'uses_contacts',
  permissions: ['contacts'],
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
const widgetPayload: HydratePayload = { ...appPayload, mode: 'widget', props: { size: '2x1' } };

async function boot(payload: HydratePayload, roots: Parameters<typeof bootAddOn>[2]) {
  const sent: ToShell[] = [];
  const parent = { postMessage: (msg: ToShell) => sent.push(msg) };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  setClientTransport(createClientTransport());
  const target = document.createElement('div');
  target.id = 'app';
  document.body.appendChild(target);

  const done = bootAddOn(manifest, UsesContacts, roots);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { kind: 'hydrate', payload },
      source: parent as unknown as Window
    })
  );
  await done;
  return { sent, parent };
}

afterEach(() => {
  resetHostsForTest();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('bootAddOn in a widget frame (MICA-245)', () => {
  it('mounts the widget root with its size, not the app, and follows a resize', async () => {
    const { parent } = await boot(widgetPayload, { widget: WidgetProbe });

    expect(document.body.textContent).toContain('widget 2x1');
    expect(document.body.textContent).not.toContain('uses contacts');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'props', props: { size: '2x2' } },
        source: parent as unknown as Window
      })
    );
    flushSync();
    expect(document.body.textContent).toContain('widget 2x2');
  });

  it('builds its host from the same permissions an app frame is hydrated with', async () => {
    // The frame's own courtesy check comes from the payload alone, whichever root it mounts,
    // so the widget meets the refusal the app would — and the shell re-checks behind it.
    await boot(widgetPayload, { widget: WidgetProbe });
    expect([...(hostFor(manifest.id)?.permissions ?? [])]).toEqual(appPayload.permissions);
  });

  it('forwards no keys and no typing from a widget frame', async () => {
    const { sent } = await boot(widgetPayload, { widget: WidgetProbe });
    sent.length = 0;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(sent.filter((m) => m.kind === 'key' || m.kind === 'typing')).toEqual([]);
  });

  it('reports an error and mounts nothing when the bundle passed no widget root', async () => {
    const { sent } = await boot(widgetPayload, {});

    expect(sent.find((m) => m.kind === 'error')).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/booted as a widget but passed no widget root/)
    });
    expect(document.body.textContent).toBe('');
  });

  it('tells the shell once the widget root has mounted', async () => {
    const { sent } = await boot(widgetPayload, { widget: WidgetProbe });
    const ready = sent.findIndex((m) => m.kind === 'ready');
    expect(ready).toBeGreaterThan(-1);
    expect(document.body.textContent).toContain('widget 2x1');
  });

  // Last on purpose: an app-mode boot leaves its `keydown` forwarder on `window`.
  it('forwards a key the player presses in an app frame while it is still hydrating', async () => {
    const sent: ToShell[] = [];
    const parent = { postMessage: (msg: ToShell) => sent.push(msg) };
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    setClientTransport(createClientTransport());
    const done = bootAddOn(manifest, UsesContacts, { widget: WidgetProbe });

    // Between `hello` and `hydrate`: the frame does not yet know it is an app.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    expect(sent.find((m) => m.kind === 'key')).toMatchObject({ kind: 'key', key: 'Escape' });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload: appPayload },
        source: parent as unknown as Window
      })
    );
    await done;
    expect(sent.some((m) => m.kind === 'ready')).toBe(false);
  });

  it('mounts the app as ever when the shell asks for the app, widget root or not', async () => {
    await boot(appPayload, { widget: WidgetProbe });

    expect(document.body.textContent).toContain('uses contacts');
    expect(document.body.textContent).not.toContain('widget');
  });
});
