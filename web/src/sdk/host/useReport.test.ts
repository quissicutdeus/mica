// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../../nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));

import { useReport } from './useReport';

describe('useReport', () => {
  it('posts createReport and resolves when the server says ok', async () => {
    transport.fetchNui.mockResolvedValueOnce({ ok: true });
    await expect(
      useReport().submit({ targetTable: 'gphone_blabs', targetId: 7, category: 'spam' })
    ).resolves.toBeUndefined();
    expect(transport.fetchNui).toHaveBeenCalledWith('createReport', {
      targetTable: 'gphone_blabs',
      targetId: 7,
      category: 'spam'
    });
  });

  it('throws the server message on error', async () => {
    transport.fetchNui.mockResolvedValueOnce({ error: 'rate limited' });
    await expect(
      useReport().submit({ targetTable: 'gphone_blabs', targetId: 7, category: 'spam' })
    ).rejects.toThrow('rate limited');
  });
});
