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
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { contacts } from '../../services/contacts';
import { conversationsStore } from '../../services/conversations';
import { media } from '../../services/media';
import { mailStore } from '../../services/mail';
import { notes } from '../../apps/notes/store';
import * as accountModule from '../../services/account';
import { ownerConfig, DEFAULT_OWNER_CONFIG } from './ownerConfig';
import { setActiveDevice } from './device';

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
      // one from the previous run. Setting it directly stands in for that.
      ownerConfig.set({ ...DEFAULT_OWNER_CONFIG, disabledApps: ['notes'] });

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
});
