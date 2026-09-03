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
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../../web/src/nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));

import { useReport } from './useReport';

describe('useReport', () => {
  it('posts createReport and resolves when the server says ok', async () => {
    transport.fetchNui.mockResolvedValueOnce({ ok: true });
    await expect(
      useReport().submit({ targetTable: 'gos_blabs', targetId: 7, category: 'spam' })
    ).resolves.toBeUndefined();
    // The generic envelope the typed `call` sends (MICA-213): service and action from
    // the contract, the payload under `data`.
    expect(transport.fetchNui).toHaveBeenCalledWith('svc', {
      service: 'reports',
      action: 'create',
      data: { targetTable: 'gos_blabs', targetId: 7, category: 'spam' }
    });
  });

  it('throws the server message on error', async () => {
    // What the real `fetchNui` does with an error reply and no default: it throws. The
    // service used to re-check `reply.error` itself, and that dead check is gone.
    transport.fetchNui.mockRejectedValueOnce(new Error('rate limited'));
    await expect(
      useReport().submit({ targetTable: 'gos_blabs', targetId: 7, category: 'spam' })
    ).rejects.toThrow('rate limited');
  });
});
