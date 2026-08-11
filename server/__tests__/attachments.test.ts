import { describe, it, expect, vi } from 'vitest';
import { resolveOwnedAttachments } from '../lib/attachments';

/**
 * The shared ownership check behind every attachment write — Messages first, Blabber
 * now too. A `photo_id` is a client-supplied row id (§2.9), so this is what stands
 * between "I attached my photo" and "I attached anyone's photo by guessing an id."
 */
describe('resolveOwnedAttachments', () => {
  const ownerOf = (owned: Set<number>) => ({
    findById: vi.fn(async (id: number, citizenid: string) =>
      owned.has(id) ? { id, citizenid } : null
    )
  });

  it('keeps an id the caller owns', async () => {
    const repo = ownerOf(new Set([5]));
    const result = await resolveOwnedAttachments([{ photo_id: 5 }], 'ABC', repo);
    expect(result).toEqual([{ photo_id: 5 }]);
  });

  it('drops an id the caller does not own, without throwing', async () => {
    const repo = ownerOf(new Set());
    const result = await resolveOwnedAttachments([{ photo_id: 9 }], 'ABC', repo);
    expect(result).toEqual([]);
  });

  it('drops a non-numeric id rather than failing the whole batch', async () => {
    const repo = ownerOf(new Set([5]));
    const result = await resolveOwnedAttachments(
      [{ photo_id: 5 }, { photo_id: 'x' }, { photo_id: -1 }],
      'ABC',
      repo
    );
    expect(result).toEqual([{ photo_id: 5 }]);
  });

  it('returns an empty array for a non-array or empty input', async () => {
    const repo = ownerOf(new Set([5]));
    expect(await resolveOwnedAttachments(undefined, 'ABC', repo)).toEqual([]);
    expect(await resolveOwnedAttachments(null, 'ABC', repo)).toEqual([]);
    expect(await resolveOwnedAttachments([], 'ABC', repo)).toEqual([]);
    expect(await resolveOwnedAttachments('not an array', 'ABC', repo)).toEqual([]);
  });
});
