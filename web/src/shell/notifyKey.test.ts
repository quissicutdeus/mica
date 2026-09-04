// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { parseNotify } from '@mica/shared/nui';

/**
 * A server toast may carry catalog keys beside its English (MICA-216). The parser lets
 * them through in the shape the shell resolves, and drops what could not be a key or a
 * param — the payload arrives over the NUI bus and is trusted for nothing.
 */
describe('parseNotify with message keys', () => {
  it('keeps key, titleKey and scalar params', () => {
    expect(
      parseNotify({
        type: 'error',
        message: 'Line busy',
        key: 'server.phone.lineBusy',
        titleKey: 'server.phone.title',
        params: { name: 'Trevor', count: 3 }
      })
    ).toEqual({
      type: 'error',
      message: 'Line busy',
      key: 'server.phone.lineBusy',
      titleKey: 'server.phone.title',
      params: { name: 'Trevor', count: 3 }
    });
  });

  it('drops params that are not short scalars, and omits the fields when nothing survives', () => {
    expect(
      parseNotify({ message: 'x', params: { ok: 'y', nested: { a: 1 }, 'bad name!': 'z' } })
    ).toEqual({ type: 'info', title: undefined, message: 'x', params: { ok: 'y' } });
    expect(parseNotify({ message: 'x', params: { nested: {} } })).toEqual({
      type: 'info',
      title: undefined,
      message: 'x'
    });
  });
});
