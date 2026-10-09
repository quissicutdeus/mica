// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Database } from '../lib/Database';
import { MarketplaceRepository } from '../repositories/MarketplaceRepository';
import { marketplace } from '../services/Marketplace';

describe('MarketplaceRepository.findAttachmentsFor', () => {
  const repo = new MarketplaceRepository(marketplace.resolved);

  beforeEach(() => vi.restoreAllMocks());

  it('returns an empty map for no ids', async () => {
    const spy = vi.spyOn(Database, 'query');
    const result = await repo.findAttachmentsFor([]);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * MICA-339 (F11). A photo moderated after it was attached kept showing on the listing,
   * because the join named the media row by id alone. Moderation only: a photo its owner
   * deleted from their own gallery still shows where they posted it, and a restore changes
   * nothing here. SQL text only — the mock cannot run it; `test:schema` drives the real join.
   */
  it('hides moderated media, and names no other status', async () => {
    const spy = vi.spyOn(Database, 'query').mockResolvedValue([] as any);
    await repo.findAttachmentsFor([10]);
    const sql = String(spy.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain("JOIN `mica_media` m ON a.media_id = m.id AND m.status <> 'moderated'");
    expect(sql).not.toMatch(/'active'|'deleted'/);
  });

  it('still shows a photo its owner deleted from their gallery', async () => {
    // What the join answers for a `deleted` row: it is not `moderated`, so it comes back.
    vi.spyOn(Database, 'query').mockResolvedValue([
      { id: 3, listing_id: 10, media_id: 100, kind: 'photo', data: 'data:image/png;base64,A' }
    ] as any);
    const result = await repo.findAttachmentsFor([10]);
    expect(result.get(10)?.map((a) => a.media.id)).toEqual([100]);
  });

  it('groups attachment rows by listing id, in insertion order', async () => {
    vi.spyOn(Database, 'query').mockResolvedValue([
      {
        id: 1,
        listing_id: 10,
        media_id: 100,
        kind: 'photo',
        data: 'base64a',
        url: null,
        thumbnail: null,
        mime_type: 'image/png',
        duration_ms: null,
        alt_text: null
      },
      {
        id: 2,
        listing_id: 10,
        media_id: 101,
        kind: 'photo',
        data: 'base64b',
        url: null,
        thumbnail: null,
        mime_type: 'image/png',
        duration_ms: null,
        alt_text: null
      }
    ] as any);

    const result = await repo.findAttachmentsFor([10]);
    expect(result.get(10)?.map((a) => a.id)).toEqual([1, 2]);
    expect(result.get(10)?.[0].media).toEqual({
      id: 100,
      kind: 'photo',
      data: 'base64a',
      url: undefined,
      thumbnail: undefined,
      mime_type: 'image/png',
      duration_ms: undefined,
      alt_text: undefined
    });
  });
});
