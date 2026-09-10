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
import { ownerConfig } from './ownerConfig';

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
      ownerConfig.set({ disabledApps: [], defaultDock: [] });
    });

    it('is skipped, while an app still enabled preloads as usual', async () => {
      // Read with `get`, not awaited (`bootstrap.ts`'s own doc) — so this only reflects an
      // answer already in hand, the way a character switch's `bootstrapStores(true)` finds
      // one from the previous run. Setting it directly stands in for that.
      ownerConfig.set({ disabledApps: ['notes'], defaultDock: [] });

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
});
