// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { contacts } from '../../services/contacts';
import { conversationsStore } from '../../services/conversations';
import { media } from '../../services/media';
import { mailStore } from '../../services/mail';
import { notes } from '../../apps/notes/store';
import * as accountModule from '../../services/account';
import * as ownerConfigModule from './ownerConfig';
import { ownerConfig, DEFAULT_OWNER_CONFIG } from './ownerConfig';
import { registeredApps } from './registry';
import { setActiveDevice } from './device';
import * as notificationsModule from '../../services/notifications';
import { currentApp, openApp } from './navigation';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(() => Promise.resolve([]))
}));

describe('bootstrapStores', () => {
  beforeEach(() => {
    resetBootstrapState();
  });

  it('preloads all primary stores in parallel', async () => {
    const spyCitizenId = vi.spyOn(accountModule, 'fetchCitizenId').mockResolvedValue('CIT-101');
    const spyBalance = vi.spyOn(accountModule, 'fetchBalance').mockResolvedValue();
    const spyContacts = vi.spyOn(contacts, 'load').mockResolvedValue();
    const spyMessages = vi.spyOn(conversationsStore, 'loadConversations').mockResolvedValue();
    const spyPhotos = vi.spyOn(media, 'load').mockResolvedValue();
    const spyMail = vi.spyOn(mailStore, 'load').mockResolvedValue();
    const spyNotes = vi.spyOn(notes, 'load').mockResolvedValue();

    await bootstrapStores(true);

    expect(spyCitizenId).toHaveBeenCalledOnce();
    expect(spyBalance).toHaveBeenCalledOnce();
    expect(spyContacts).toHaveBeenCalledOnce();
    expect(spyMessages).toHaveBeenCalledOnce();
    expect(spyPhotos).toHaveBeenCalledOnce();
    expect(spyMail).toHaveBeenCalledOnce();
    expect(spyNotes).toHaveBeenCalledOnce();
  });

  describe('MICA-234: an app the owner already disabled', () => {
    afterEach(() => {
      ownerConfig.set(DEFAULT_OWNER_CONFIG);
    });

    it('is skipped, while an app still enabled preloads as usual', async () => {
      // Read with `get`, not awaited (`bootstrap.ts`'s own doc) — so this only reflects an
      // answer already in hand, the way a character switch's `bootstrapStores(true)` finds
      // one from the previous run. Setting it directly stands in for that, and this run's
      // own ask is held off: since MICA-364 the list is read when the deferred preloads run,
      // by which time the mocked reply would otherwise have replaced it with the defaults.
      ownerConfig.set({ ...DEFAULT_OWNER_CONFIG, disabledApps: ['notes'] });
      vi.spyOn(ownerConfigModule, 'refreshOwnerConfig').mockResolvedValue();

      const spyCitizenId = vi.spyOn(accountModule, 'fetchCitizenId').mockResolvedValue('CIT-101');
      vi.spyOn(accountModule, 'fetchBalance').mockResolvedValue();
      const spyContacts = vi.spyOn(contacts, 'load').mockResolvedValue();
      const spyNotes = vi.spyOn(notes, 'load').mockResolvedValue();
      // `vi.spyOn` on a method the earlier test already spied (and never restored) hands
      // back that same mock, carry-over calls and all — clear each one so this test's
      // assertions are about what *this* run did, not the file's whole history.
      spyCitizenId.mockClear();
      spyContacts.mockClear();
      spyNotes.mockClear();

      await bootstrapStores(true);

      expect(spyNotes).not.toHaveBeenCalled();
      // Proof this is a targeted skip, not every preload going quiet.
      expect(spyContacts).toHaveBeenCalledOnce();
      expect(spyCitizenId).toHaveBeenCalledOnce();
    });
  });

  /**
   * MICA-264: the server refuses a tablet's request to a service that is the phone's alone,
   * so preloading an app the tablet does not show was a refusal per app on every boot.
   */
  describe('MICA-264: an app the active device does not show', () => {
    afterEach(() => setActiveDevice('phone'));

    it('is skipped on the tablet, while an app the tablet shows preloads as usual', async () => {
      setActiveDevice('tablet');
      const spyCitizenId = vi.spyOn(accountModule, 'fetchCitizenId').mockResolvedValue('CIT-101');
      vi.spyOn(accountModule, 'fetchBalance').mockResolvedValue();
      // Contacts, Messages, Photos and Mail are phone apps (no `devices`); Notes is on both.
      const spyContacts = vi.spyOn(contacts, 'load').mockResolvedValue();
      const spyMessages = vi.spyOn(conversationsStore, 'loadConversations').mockResolvedValue();
      const spyPhotos = vi.spyOn(media, 'load').mockResolvedValue();
      const spyMail = vi.spyOn(mailStore, 'load').mockResolvedValue();
      const spyNotes = vi.spyOn(notes, 'load').mockResolvedValue();
      for (const spy of [spyCitizenId, spyContacts, spyMessages, spyPhotos, spyMail, spyNotes]) {
        spy.mockClear();
      }

      await bootstrapStores(true);

      expect(spyContacts).not.toHaveBeenCalled();
      expect(spyMessages).not.toHaveBeenCalled();
      expect(spyPhotos).not.toHaveBeenCalled();
      expect(spyMail).not.toHaveBeenCalled();
      expect(spyNotes).toHaveBeenCalledOnce();
      // The shell's own reads are not app preloads, and still run.
      expect(spyCitizenId).toHaveBeenCalledOnce();

      // And the phone, after a switch back, preloads its apps again.
      setActiveDevice('phone');
      resetBootstrapState();
      await bootstrapStores(true);
      expect(spyContacts).toHaveBeenCalledOnce();
    });
  });

  /**
   * MICA-364: the app preloads wait out the open animation, and start the moment an app is
   * shown if that comes first — so no store is any later than before by the time its app is up.
   */
  describe('MICA-364: app preloads after the open animation', () => {
    /** `PhoneFrame`'s fly-in, `duration: 500`, which `bootstrap.ts` waits out. */
    const FLY_IN_MS = 500;

    beforeEach(() => {
      vi.useFakeTimers();
      currentApp.set({ id: 'home', props: {} });
    });

    afterEach(async () => {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      currentApp.set({ id: 'home', props: {} });
      // The manifest `preload` spies sit on shared registry objects; put them back.
      vi.restoreAllMocks();
    });

    const spies = () => {
      const citizenId = vi.spyOn(accountModule, 'fetchCitizenId').mockResolvedValue('CIT-101');
      vi.spyOn(accountModule, 'fetchBalance').mockResolvedValue();
      const notesLoad = vi.spyOn(notes, 'load').mockResolvedValue();
      const contactsLoad = vi.spyOn(contacts, 'load').mockResolvedValue();
      const unread = vi.spyOn(notificationsModule, 'loadUnreadCounts').mockResolvedValue();
      for (const spy of [citizenId, notesLoad, contactsLoad, unread]) spy.mockClear();
      return { citizenId, notesLoad, contactsLoad, unread };
    };

    /**
     * The contacts manifest's own `preload`, spied. It awaits a chunk import before it calls
     * `load`, so "started in the same tick" is a question about the preload, not the load.
     */
    const contactsPreload = () => {
      const manifest = registeredApps.find((app) => app.id === 'contacts') as unknown as {
        preload: () => Promise<unknown>;
      };
      const spy = vi.spyOn(manifest, 'preload').mockResolvedValue(undefined);
      spy.mockClear();
      return spy;
    };

    it('starts the shell reads with the open and the app preloads after the fly-in', async () => {
      const { citizenId, notesLoad, contactsLoad } = spies();

      const done = bootstrapStores();
      expect(citizenId).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(FLY_IN_MS - 1);
      expect(notesLoad).not.toHaveBeenCalled();
      expect(contactsLoad).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(contactsLoad).toHaveBeenCalledOnce();
      // `notes` imports its store chunk first; let that land.
      await done;
      expect(notesLoad).toHaveBeenCalledOnce();
    });

    it('starts them in the same tick an app is opened, before it can be shown', async () => {
      spies();
      const preload = contactsPreload();

      void bootstrapStores();
      await vi.advanceTimersByTimeAsync(100);
      expect(preload).not.toHaveBeenCalled();

      openApp('contacts');
      // Synchronous: nothing has rendered yet, and the preload is already in flight.
      expect(preload).toHaveBeenCalledOnce();

      // And the timer does not start them a second time.
      await vi.advanceTimersByTimeAsync(FLY_IN_MS);
      expect(preload).toHaveBeenCalledOnce();
    });

    it('runs them at once when the phone opens onto an app already up', async () => {
      spies();
      const preload = contactsPreload();
      currentApp.set({ id: 'contacts', props: {} });

      void bootstrapStores();
      expect(preload).toHaveBeenCalledOnce();
    });

    it("drops a superseded run's preloads, so a switch never lands the old identity's", async () => {
      const { contactsLoad } = spies();

      void bootstrapStores();
      resetBootstrapState();
      await vi.advanceTimersByTimeAsync(FLY_IN_MS * 2);
      expect(contactsLoad).not.toHaveBeenCalled();
    });

    it('shares a run still in flight with a reopen inside the window', async () => {
      const { citizenId } = spies();
      const preload = contactsPreload();

      const first = bootstrapStores();
      const second = bootstrapStores();
      await vi.advanceTimersByTimeAsync(FLY_IN_MS);
      await Promise.all([first, second]);
      // One run: the shell reads were asked once, not once per open.
      expect(citizenId).toHaveBeenCalledOnce();
      expect(preload).toHaveBeenCalledOnce();
    });

    it("leaves the open's unread counts to the shade it mounts, and asks on a forced run", async () => {
      const { unread } = spies();

      void bootstrapStores();
      await vi.advanceTimersByTimeAsync(FLY_IN_MS);
      expect(unread).not.toHaveBeenCalled();

      void bootstrapStores(true);
      expect(unread).toHaveBeenCalledOnce();
    });
  });
});

/**
 * The capabilities ask at first open (no ticket; the MICA-364 leftover). `Shell.svelte` asks at
 * mount, so the open asks again only if that ask failed or never came — and a failed one must
 * be repaired there, since at resource start it reaches `ServiceEndpoint`'s auth before a
 * character has loaded.
 */
describe('bootstrapStores and the capabilities answer', () => {
  /**
   * A fresh module graph per test. `capabilities.ts` keeps a real answer once it has one, and
   * every forced run earlier in this file has given it one — so "the mount-time ask failed"
   * is only reachable in a copy that has never been answered.
   */
  const fresh = async () => {
    vi.resetModules();
    // The new graph's facets, before anything in it reads one (`serverLocale.test.ts` too).
    await import('../../host/registerFacets');
    const { fetchNui: transport } = await import('../../nui/fetchNui');
    const capabilitiesModule = await import('../../services/capabilities');
    const account = await import('../../services/account');
    const bootstrap = await import('./bootstrap');
    vi.spyOn(account, 'fetchCitizenId').mockResolvedValue('CIT-101');
    vi.spyOn(account, 'fetchBalance').mockResolvedValue();
    const transportMock = vi.mocked(transport);
    // Only now: the modules just imported start their own `setInterval`s at import, and
    // under fake timers `runAllTimersAsync` would chase them forever.
    vi.useFakeTimers();

    return {
      ...capabilitiesModule,
      /** How many times the server was asked what it can do. */
      capabilityAsks: () =>
        transportMock.mock.calls.filter(
          ([, data]) => (data as { action?: string })?.action === 'capabilities'
        ).length,
      /** Stand in for `Shell.svelte`'s mount-time ask, answered with `reply`. */
      askAtMount: async (reply: () => Promise<unknown>) => {
        transportMock.mockImplementationOnce(reply);
        await capabilitiesModule.refreshCapabilities();
        transportMock.mockClear();
      },
      answerNext: (reply: () => Promise<unknown>) => transportMock.mockImplementationOnce(reply),
      /** A run, preloads and all; unforced is the first open. */
      run: async (force = false) => {
        const done = bootstrap.bootstrapStores(force);
        await vi.runAllTimersAsync();
        await done;
      }
    };
  };

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not ask again on first open when the mount-time ask was answered', async () => {
    const m = await fresh();
    await m.askAtMount(async () => ({ money: true }));
    expect(get(m.capabilitiesKnown)).toBe(true);

    await m.run();

    expect(m.capabilityAsks()).toBe(0);
    expect(get(m.capabilities).money).toBe(true);
  });

  it('repairs a mount-time ask that failed, by asking again on first open', async () => {
    const m = await fresh();
    await m.askAtMount(async () => {
      throw new Error('no character loaded');
    });
    // Denied, but not presented as the server's answer.
    expect(get(m.capabilities).money).toBe(false);
    expect(get(m.capabilitiesKnown)).toBe(false);

    m.answerNext(async () => ({ money: true }));
    await m.run();

    expect(m.capabilityAsks()).toBe(1);
    expect(get(m.capabilities).money).toBe(true);
    expect(get(m.capabilitiesKnown)).toBe(true);
  });

  it('always asks on a forced run, since a character switch can change the answer', async () => {
    const m = await fresh();
    await m.askAtMount(async () => ({ money: true }));

    await m.run(true);

    expect(m.capabilityAsks()).toBe(1);
  });
});
