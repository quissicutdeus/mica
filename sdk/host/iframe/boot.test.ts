// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { bootAddOn } from './boot';
import { resetHostsForTest } from '../current';
import UsesContacts from '../__fixtures__/UsesContacts.svelte';
import PropsProbe from '../__fixtures__/PropsProbe.svelte';
import type { AppManifest } from '../../manifest';
import type { HydratePayload, ToShell } from './messages';

// MICA-16 step 4: boot is the one function an add-on bundle actually calls — this test
// drives it the way the real iframe would be driven, over a fake window.parent, rather than
// through fakeTransport() (which skips the postMessage wiring boot.ts is responsible for).

const manifest: AppManifest = {
  id: 'uses_contacts',
  name: 'Uses Contacts',
  tile: { bg: 'bg-indigo-600' },
  icon: null,
  core: false,
  permissions: ['contacts']
};

const payload: HydratePayload = {
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

function stubParent() {
  const sent: ToShell[] = [];
  const parent = { postMessage: (msg: ToShell) => sent.push(msg) };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  return { sent, parent };
}

afterEach(() => {
  resetHostsForTest();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('bootAddOn', () => {
  it('says hello, hydrates, applies theme, mounts the app, and forwards keydown', async () => {
    const { sent, parent } = stubParent();
    const target = document.createElement('div');
    target.id = 'app';
    document.body.appendChild(target);

    const bootDone = bootAddOn(manifest, UsesContacts);

    expect(sent[0]).toEqual({ kind: 'hello', appId: manifest.id });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload },
        source: parent as unknown as Window
      })
    );

    await bootDone;

    expect(document.documentElement.getAttribute('style')).toBe(payload.theme);
    expect(document.body.textContent).toContain('uses contacts');

    sent.length = 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect(sent[0]).toMatchObject({ kind: 'key', key: 'a', code: 'KeyA' });
  });

  it('boots from the manifest id alone, and says hello with it (MICA-449)', async () => {
    // The add-on build's entry hands over `{ id }` and nothing else, so a manifest's badge
    // factory never lands in the frame's bundle. Everything else the frame needs arrives
    // in hydrate, so an id-only call has to boot and mount exactly as a whole manifest did.
    const { sent, parent } = stubParent();
    const target = document.createElement('div');
    target.id = 'app';
    document.body.appendChild(target);

    const bootDone = bootAddOn({ id: 'uses_contacts' }, UsesContacts);

    expect(sent[0]).toEqual({ kind: 'hello', appId: 'uses_contacts' });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload },
        source: parent as unknown as Window
      })
    );
    await bootDone;

    expect(document.body.textContent).toContain('uses contacts');
  });

  it('types the manifest as its id, and still takes a whole one (MICA-449)', () => {
    // What makes a read of any other manifest field inside boot.ts a compile error rather
    // than a runtime `undefined` in every add-on built from the id-only entry.
    expectTypeOf<Parameters<typeof bootAddOn>[0]>().toEqualTypeOf<Pick<AppManifest, 'id'>>();

    // A caller still passing a whole manifest compiles, as a variable and written inline;
    // a plain `Pick` parameter would reject each extra field of the inline literal.
    // The calls sit in arrows that never run: this test is for the checker.
    expectTypeOf(() => bootAddOn(manifest, UsesContacts)).toBeFunction();
    expectTypeOf(() =>
      bootAddOn(
        {
          id: 'inline',
          name: 'Inline',
          tile: { bg: 'bg-indigo-600' },
          icon: null,
          core: false,
          permissions: ['contacts']
        },
        UsesContacts
      )
    ).toBeFunction();

    // @ts-expect-error - the id is what `hello` sends, so it stays required.
    expectTypeOf(() => bootAddOn({}, UsesContacts)).toBeFunction();
  });

  it('reports an unhandled rejection inside the frame as an error message', async () => {
    // The shell cannot see into the sandbox: an add-on that rejects a promise nobody awaits
    // would otherwise fail invisibly, since the frame's console is not the shell's. This
    // forwarder is what turns it into `AddOnFrame`'s crash screen.
    const { sent, parent } = stubParent();
    const target = document.createElement('div');
    target.id = 'app';
    document.body.appendChild(target);

    const bootDone = bootAddOn(manifest, UsesContacts);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload },
        source: parent as unknown as Window
      })
    );
    await bootDone;

    sent.length = 0;
    const reason = new Error('nobody awaited me');
    // jsdom has no `PromiseRejectionEvent`, so the event carrying `reason` is built by hand.
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));

    const errors = sent.filter((m) => m.kind === 'error');
    expect(errors[0]).toMatchObject({ kind: 'error', message: 'nobody awaited me' });
    expect(errors[0].stack).toBe(reason.stack);
  });

  it('updates a running app when the shell pushes new deep-link props (MICA-25)', async () => {
    // Re-opening an already-running add-on by a new deep link used to leave it showing
    // its original props: the frame already ran its one `hello`, so nothing hydrated it
    // again. A `props` push into the same reactive object `mount()` was given is what
    // makes a second deep link actually reach the running app.
    const { parent } = stubParent();
    const target = document.createElement('div');
    target.id = 'app';
    document.body.appendChild(target);

    const bootDone = bootAddOn({ ...manifest, id: 'props_probe' }, PropsProbe);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload: { ...payload, appId: 'props_probe', props: {} } },
        source: parent as unknown as Window
      })
    );
    await bootDone;

    expect(document.body.textContent).toContain('none');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'props', props: { label: 'from a deep link' } },
        source: parent as unknown as Window
      })
    );
    flushSync();

    expect(document.body.textContent).toContain('from a deep link');
  });

  it('drops a held key repeat rather than forwarding it', async () => {
    // A wire `key` message carries no `repeat` flag, so the shell's `routeKey` would
    // treat every one as a fresh press — a bound action would fire on every OS repaint
    // a key is held for, instead of once. The forwarder has to drop it here, at source.
    const { sent, parent } = stubParent();
    const target = document.createElement('div');
    target.id = 'app';
    document.body.appendChild(target);

    const bootDone = bootAddOn(manifest, UsesContacts);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'hydrate', payload },
        source: parent as unknown as Window
      })
    );
    await bootDone;

    sent.length = 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', repeat: true }));
    expect(sent).toHaveLength(0);
  });
});
