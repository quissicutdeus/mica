// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import './inProcess/registerFacets';
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
