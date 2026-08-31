// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../sdk/host/inProcess/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('../nui/fetchNui', () => ({ fetchNui: vi.fn(async () => ({})) }));

import { createNuiMessageRouter } from './nuiMessages';
import { toast } from './state/toast';
import { time } from './state/time';
import { charge } from './state/charge';
import { signalLevel } from './state/signal';
import { contacts } from '../services/contacts';
import { appRegistryStore } from './state/registry';
import { audibleBroadcasts, nearbyBroadcasts, resetNearbyMusicForTest } from './state/nearbyMusic';

/**
 * These twelve branches previously lived inside `App.svelte` and had no unit tests at
 * all — a handful of e2e specs touched three of them. The contact-share path in
 * particular does real validation, and a share arriving with no name or number would
 * otherwise be written as a blank contact.
 */

const message = (action: string, data?: unknown) => ({ data: { action, data } }) as MessageEvent;

let opened: { app: string; props?: Record<string, unknown> }[] = [];
const route = createNuiMessageRouter({
  openFromNotification: (app, props) => opened.push({ app, props })
});

/** The most recent toast, whatever kind. */
const lastToast = () => get(toast)[0];

beforeEach(() => {
  opened = [];
  toast.clear();
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('reports whether it consumed the message', () => {
    // The shell relies on this to know what is left for it to handle.
    expect(route(message('setTime', { hours: 1, minutes: 2 }))).toBe(true);
    expect(route(message('setVisible', true))).toBe(false);
    expect(route(message('callStatus', { status: 'idle' }))).toBe(false);
  });

  it('survives a malformed message', () => {
    expect(() => route({ data: undefined } as MessageEvent)).not.toThrow();
    expect(route({ data: {} } as MessageEvent)).toBe(false);
    expect(route(message('somethingElse'))).toBe(false);
  });
});

describe('hardware state', () => {
  it('sets the clock', () => {
    route(message('setTime', { hours: 9, minutes: 30 }));
    expect(get(time)).toEqual({ hours: 9, minutes: 30 });
  });

  it('ignores a non-numeric charge or signal', () => {
    charge.set(50);
    signalLevel.set(3);

    route(message('setCharge', 'nonsense'));
    route(message('setSignal', null));

    expect(get(charge)).toBe(50);
    expect(get(signalLevel)).toBe(3);
  });

  it('accepts numeric ones', () => {
    route(message('setCharge', 12));
    route(message('setSignal', 1));
    expect(get(charge)).toBe(12);
    expect(get(signalLevel)).toBe(1);
  });
});

describe('notify', () => {
  it('shows a server-originated toast', () => {
    route(message('notify', { type: 'error', title: 'Denied', message: 'No permission' }));
    expect(lastToast()).toMatchObject({ type: 'error', message: 'No permission' });
  });

  it('defaults the type', () => {
    route(message('notify', { message: 'Plain' }));
    expect(lastToast()).toMatchObject({ type: 'info' });
  });

  it('ignores an empty or missing message', () => {
    route(message('notify', { message: '' }));
    route(message('notify', {}));
    route(message('notify', { message: 42 }));
    expect(get(toast)).toHaveLength(0);
  });
});

describe('appEvent toasts', () => {
  /** A pushed event for Blabber, which is a bundled add-on declaring `notifications`. */
  const blabberEvent = () =>
    message('appEvent', {
      app: 'blabber',
      event: 'mention',
      payload: {},
      at: Date.now(),
      notify: { message: '@ada mentioned you' }
    });

  it('raises no toast for a bundled add-on that has never been installed', () => {
    // The manifest resolves — `getManifest` falls back to the bundled add-ons so a deep
    // link can render one — and it declares `notifications`. Neither fact means the player
    // has the app, and a phone without Blabber must not show Blabber's toasts.
    expect(appRegistryStore.isInstalled('blabber')).toBe(false);
    expect(appRegistryStore.getManifest('blabber')?.permissions).toContain('notifications');

    route(blabberEvent());

    expect(get(toast)).toHaveLength(0);
  });

  it('raises the toast once the same app is installed', () => {
    const manifest = appRegistryStore.getManifest('blabber')!;
    appRegistryStore.registerAddOn(manifest, 'export default {}');
    try {
      expect(appRegistryStore.isInstalled('blabber')).toBe(true);

      route(blabberEvent());

      expect(lastToast()).toMatchObject({ app: 'blabber', message: '@ada mentioned you' });
    } finally {
      appRegistryStore.unregisterApp('blabber');
    }
  });
});

describe('notification click-through', () => {
  it('opens Mail on the message that arrived', () => {
    route(message('receiveMail', { id: 7, sender: 'a@b.c', subject: 'Hi' }));
    lastToast()?.onClick?.();
    expect(opened).toEqual([{ app: 'mail', props: { mailId: 7 } }]);
  });

  it('opens the conversation a message belongs to', () => {
    route(message('receiveMessage', { conversation_id: 3, phone: '555', message: 'yo' }));
    lastToast()?.onClick?.();
    expect(opened).toEqual([{ app: 'messages', props: { conversationId: 3, phone: '555' } }]);
  });

  it('falls back to senderPhone when phone is absent', () => {
    route(message('receiveMessage', { conversation_id: 4, senderPhone: '999' }));
    lastToast()?.onClick?.();
    expect(opened[0].props).toMatchObject({ phone: '999' });
  });
});

describe('installApp', () => {
  const catalogEntry = {
    id: 'remote_weather',
    name: 'Weather',
    version: '1.0.0',
    description: 'Live weather.',
    bundleUrl: 'https://example.com/app.js',
    sha256: 'a'.repeat(64),
    color: 'bg-blue-500',
    permissions: []
  };

  it('rejects a data: URL before it ever reaches installFromCatalog', () => {
    const installFromCatalog = vi.spyOn(appRegistryStore, 'installFromCatalog');

    route(message('installApp', { ...catalogEntry, bundleUrl: 'data:text/javascript,alert(1)' }));

    expect(installFromCatalog).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({
      type: 'error',
      message: expect.stringContaining('data:')
    });
  });

  it('routes a valid catalog entry to installFromCatalog', () => {
    const installFromCatalog = vi
      .spyOn(appRegistryStore, 'installFromCatalog')
      .mockRejectedValue(new Error('not trusted'));

    route(message('installApp', catalogEntry));

    expect(installFromCatalog).toHaveBeenCalledWith(catalogEntry);
  });

  it('rejects the old { url } shape — it has no catalog entry to build a manifest from', () => {
    const installFromCatalog = vi.spyOn(appRegistryStore, 'installFromCatalog');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    route(message('installApp', { url: 'https://example.com/app.js' }));

    expect(installFromCatalog).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[gPhone] installApp: payload is not a CatalogEntry', {
      url: 'https://example.com/app.js'
    });
    expect(lastToast()).toMatchObject({
      type: 'error',
      message: expect.stringContaining('invalid catalog entry')
    });
  });

  it('rejects any other malformed payload the same way, rather than failing silently', () => {
    const installFromCatalog = vi.spyOn(appRegistryStore, 'installFromCatalog');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    route(message('installApp', null));
    route(message('installApp', 'not an object'));
    route(message('installApp', {}));

    expect(installFromCatalog).not.toHaveBeenCalled();
  });
});

describe('contact share', () => {
  const accept = async () => {
    const current = lastToast();
    const actions = current?.actions ?? [];
    await actions.find((a: { label: string }) => a.label === 'Accept')?.onClick();
    // Mirrors ToastHost.svelte's handleActionClick: the acted-upon toast is dismissed
    // once its action resolves, which is what lets any toast it raised (e.g. an error)
    // take the now-empty visible slot instead of sitting queued behind it.
    if (current) toast.dismiss(current.id);
  };

  it('adds a valid contact', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);
    route(message('shareContact', { firstname: 'Franklin', lastname: 'C', phone: '555-0177' }));
    await accept();

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ firstname: 'Franklin', phone: '555-0177' })
    );
  });

  it('refuses a share with no name or number, rather than writing a blank contact', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);

    route(message('shareContact', { lastname: 'Clinton' }));
    await accept();
    expect(add).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ type: 'error' });

    route(message('shareContact', { firstname: '   ', phone: '  ' }));
    await accept();
    expect(add).not.toHaveBeenCalled();
  });

  it('trims whitespace off the fields it keeps', async () => {
    const add = vi.spyOn(contacts, 'add').mockResolvedValue(undefined as never);
    route(message('shareContact', { firstname: '  Frank  ', phone: ' 555 ', lastname: ' C ' }));
    await accept();

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ firstname: 'Frank', phone: '555', lastname: 'C' })
    );
  });

  it('surfaces a failure instead of claiming success', async () => {
    vi.spyOn(contacts, 'add').mockRejectedValue(new Error('duplicate'));
    route(message('shareContact', { firstname: 'A', phone: '1' }));
    await accept();

    expect(lastToast()).toMatchObject({ type: 'error', message: 'duplicate' });
  });

  it('answers to both names the client has used', () => {
    expect(route(message('shareContact', { firstname: 'A', phone: '1' }))).toBe(true);
    expect(route(message('receiveContactShare', { firstname: 'A', phone: '1' }))).toBe(true);
  });

  /**
   * MICA-155: `firstname`/`lastname`/`phone` on the card are the sender's own free
   * choice — `contacts.share` forwards any saved card, not only the sender's own — so
   * they carry no provenance by themselves. `sender` is attached server-side from the
   * actual connection that sent the event and must be what the player sees identified as
   * the sender, in the text the toast actually renders, before they decide whether to
   * Accept.
   */
  describe('surfaces the true sender, independent of what the card claims', () => {
    it('shows the resolved sender name even when the card claims someone else entirely', () => {
      route(
        message('shareContact', {
          firstname: 'John',
          lastname: 'Doe',
          phone: '555-0199',
          sender: { citizenid: 'ABC123', name: 'Trevor Philips', phone: '555-0000' }
        })
      );

      const shown = lastToast();
      expect(shown?.title).toContain('Trevor Philips');
      expect(shown?.title).not.toContain('John');
      // The claimed card identity is still visible too, just not mistaken for the sender.
      expect(shown?.message).toBe('John Doe (555-0199)');
    });

    it('falls back to the sender citizenid when the framework has no resolved name', () => {
      route(
        message('shareContact', {
          firstname: 'Franklin',
          phone: '555-0177',
          sender: { citizenid: 'XYZ789', name: null, phone: null }
        })
      );

      expect(lastToast()?.title).toContain('XYZ789');
    });

    it('never renders blank or silent — an old server or mock with no sender still says so', () => {
      route(message('shareContact', { firstname: 'Franklin', phone: '555-0177' }));

      const shown = lastToast();
      expect(shown?.title).toBeTruthy();
      expect(shown?.title).toContain('Unknown sender');
    });
  });
});

/**
 * The two nearby-music routes. MICA-111 phase 2.
 *
 * The transport half of the feature the ticket says must not be missing, and the one
 * place both halves of it meet: a roster from the server and a volume map from the game
 * client, arriving as separate messages at different rates. A missing route here is a
 * feature that is silently dead in game while every other suite passes (AGENTS.md §8),
 * which is exactly what this file exists to catch.
 */
describe('nearby music', () => {
  const VIDEO = 'dQw4w9WgXcQ';
  const broadcast = (token: string, source = 41) => ({
    source,
    token,
    label: null,
    videoId: VIDEO,
    playlistId: null,
    startedAt: Date.now(),
    paused: false
  });

  beforeEach(() => resetNearbyMusicForTest());

  it('routes a roster and the volumes that make it audible', () => {
    expect(route(message('musicBroadcasts', { broadcasts: [broadcast('a')] }))).toBe(true);
    expect(get(nearbyBroadcasts).map((b) => b.token)).toEqual(['a']);

    // Nothing plays on the roster alone: a volume the game client has not sent is not
    // permission to play at full. The volume map is keyed by `source`, which is the only
    // handle the game client can measure a distance to.
    expect(get(audibleBroadcasts)).toEqual([]);
    expect(route(message('musicBroadcastVolumes', { volumes: { 41: 0.6 } }))).toBe(true);
    expect(get(audibleBroadcasts).map((b) => b.token)).toEqual(['a']);
  });

  it('treats an empty roster as the end of a broadcast rather than a malformed message', () => {
    route(message('musicBroadcasts', { broadcasts: [broadcast('a')] }));
    route(message('musicBroadcastVolumes', { volumes: { 41: 0.6 } }));

    route(message('musicBroadcasts', { broadcasts: [] }));
    expect(get(nearbyBroadcasts)).toEqual([]);
    expect(get(audibleBroadcasts)).toEqual([]);
  });

  it('leaves state alone when the payload is not a roster at all', () => {
    route(message('musicBroadcasts', { broadcasts: [broadcast('a')] }));
    route(message('musicBroadcasts', { nope: true }));
    route(message('musicBroadcasts', 'a string'));
    expect(get(nearbyBroadcasts).map((b) => b.token)).toEqual(['a']);
  });

  it('raises no toast and opens nothing — audio is the answer, not an interruption', () => {
    route(message('musicBroadcasts', { broadcasts: [broadcast('a')] }));
    expect(get(toast)).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it('does not let a volume map poison the lookup it is used for', () => {
    route(message('musicBroadcasts', { broadcasts: [broadcast('a')] }));
    route(
      message('musicBroadcastVolumes', {
        volumes: JSON.parse('{"__proto__": {"polluted": 1}, "41": 0.5}')
      })
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(get(audibleBroadcasts).map((b) => b.token)).toEqual(['a']);
  });
});
