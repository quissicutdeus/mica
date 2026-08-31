// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { contacts } from '../../services/contacts';
import { conversationsStore } from '../../services/conversations';
import { media } from '../../services/media';
import { mailStore } from '../../services/mail';
import { notes } from '../../apps/notes/store';
import * as accountModule from '../../services/account';

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
});
