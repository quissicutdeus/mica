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
