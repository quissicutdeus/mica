import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { contacts } from './contacts';
import { messagesStore } from './messages';
import { photos } from './photos';
import { mailStore } from './mail';
import { notes } from './notes';
import * as accountModule from './account';

vi.mock('../utils/fetchNui', () => ({
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
    const spyMessages = vi.spyOn(messagesStore, 'loadConversations').mockResolvedValue();
    const spyPhotos = vi.spyOn(photos, 'load').mockResolvedValue();
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
