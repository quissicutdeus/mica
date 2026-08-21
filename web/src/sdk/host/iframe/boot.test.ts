import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootAddOn } from './boot';
import { resetHostsForTest } from '../current';
import UsesContacts from '../__fixtures__/UsesContacts.svelte';
import type { AppManifest } from '../../manifest';
import type { HydratePayload, ToShell } from './messages';

// MICA-16 step 4: boot is the one function an add-on bundle actually calls — this test
// drives it the way the real iframe would be driven, over a fake window.parent, rather than
// through fakeTransport() (which skips the postMessage wiring boot.ts is responsible for).

const manifest: AppManifest = {
  id: 'uses_contacts',
  name: 'Uses Contacts',
  color: 'bg-indigo-600',
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
    theme: { defaultTheme: null }
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

    expect(sent[0]).toEqual({ kind: 'hello', manifest });

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
});
