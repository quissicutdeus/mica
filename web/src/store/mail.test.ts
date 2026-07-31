import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mailStore, unreadMailCount } from './mail';
import { get } from 'svelte/store';
import * as fetchNuiModule from '../utils/fetchNui';

describe('mailStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads received mail list', async () => {
    const mockMails = [
      {
        id: 1,
        sender: 'Maze Bank',
        subject: 'Statement Ready',
        content: 'Your statement is ready',
        read: false,
        status: 'active'
      }
    ];

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockMails as any);

    await mailStore.load();
    expect(get(mailStore)).toEqual(mockMails);
    expect(get(unreadMailCount)).toBe(1);
  });

  it('marks mail as read', async () => {
    const mockMails = [
      {
        id: 1,
        sender: 'Maze Bank',
        subject: 'Statement Ready',
        content: 'Info',
        read: false,
        status: 'active'
      }
    ];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockMails as any);
    await mailStore.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);
    await mailStore.markAsRead(1);

    expect(get(mailStore)[0].read).toBe(true);
    expect(get(unreadMailCount)).toBe(0);
  });

  it('deletes mail by id', async () => {
    const mockMails = [
      { id: 1, sender: 'Maze Bank', subject: 'Sub 1', content: 'C1', read: true, status: 'active' },
      {
        id: 2,
        sender: 'Weazel News',
        subject: 'Sub 2',
        content: 'C2',
        read: false,
        status: 'active'
      }
    ];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockMails as any);
    await mailStore.load();

    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true as any);
    await mailStore.delete(1);

    expect(get(mailStore)).toEqual([
      {
        id: 2,
        sender: 'Weazel News',
        subject: 'Sub 2',
        content: 'C2',
        read: false,
        status: 'active'
      }
    ]);
  });

  it('adds newly received mail to store', () => {
    const newMail = {
      id: 3,
      sender: 'Police Dept',
      subject: 'Citation',
      content: 'Fine details',
      read: false,
      status: 'active'
    };
    mailStore.addReceivedMail(newMail as any);

    expect(get(mailStore)).toContainEqual(newMail);
  });
});
