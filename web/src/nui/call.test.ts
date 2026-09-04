// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';

const fetchNui = vi.hoisted(() => vi.fn());
vi.mock('./fetchNui', () => ({ fetchNui }));

import { call, callOr } from './call';
import { mediaContract } from '@mica/shared/contracts/media';

/**
 * `call` is a thin, typed shape over the generic service action (MICA-213). What is
 * worth asserting is the envelope, because the relay and the browser mock both key on
 * it: `{ service, action, data }` under the one generic NUI action, service taken from the
 * contract rather than typed again by hand.
 */
describe('call', () => {
  it('sends the contract id, the action and the input under the generic service action', async () => {
    fetchNui.mockResolvedValueOnce({ id: 1, media: null });
    const reply = await call(mediaContract, 'shareLocation', { label: 'Vespucci' });
    expect(fetchNui).toHaveBeenCalledWith(GENERIC_SERVICE_ACTION, {
      service: 'media',
      action: 'shareLocation',
      data: { label: 'Vespucci' }
    });
    expect(reply).toEqual({ id: 1, media: null });
  });

  it('callOr hands the default through as a defaulted read', async () => {
    fetchNui.mockResolvedValueOnce('fallback');
    await callOr(mediaContract, 'shareLocation', {}, 'fallback');
    expect(fetchNui).toHaveBeenLastCalledWith(
      GENERIC_SERVICE_ACTION,
      { service: 'media', action: 'shareLocation', data: {} },
      { defaultValue: 'fallback', quiet: undefined }
    );
  });

  it('callOr passes quiet through for a read that may run before a character loads', async () => {
    fetchNui.mockResolvedValueOnce([]);
    await callOr(mediaContract, 'shareLocation', {}, [], { quiet: true });
    expect(fetchNui).toHaveBeenLastCalledWith(
      GENERIC_SERVICE_ACTION,
      { service: 'media', action: 'shareLocation', data: {} },
      { defaultValue: [], quiet: true }
    );
  });
});
