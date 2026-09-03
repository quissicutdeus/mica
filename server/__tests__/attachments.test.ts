// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { resolveOwnedAttachments } from '../lib/attachments';
import { MAX_ATTACHMENTS } from '@gos/shared/attachments';

/**
 * The shared ownership check behind every attachment write — Messages first, Blabber
 * now too. A `photo_id` is a client-supplied row id (§2.9), so this is what stands
 * between "I attached my photo" and "I attached anyone's photo by guessing an id."
 */
const ownerOf = (owned: Set<number>) => ({
  findById: vi.fn(async (id: number, citizenid: string) =>
    owned.has(id) ? { id, citizenid } : null
  )
});

describe('resolveOwnedAttachments', () => {
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

/**
 * MICA-154. The loop issues one sequential `findById` per element and `fields()` bounds
 * nothing, so the array arrived at whatever length a modified client sent: 20,000 elements
 * was 20,000 queries inside one net event, plus a `console.warn` per dropped id — a log an
 * attacker could grow without bound. Marketplace's `MAX_ATTACHMENTS` was applied with a
 * `.slice()` *after* this returned, which bounded what was stored and not the work that
 * produced it.
 *
 * The rate limiter is not a second line of defence here: it keys per action rather than per
 * player and nothing decrements on completion, so it permits 60 concurrent of these per
 * action across three services (MICA-131/132).
 */
describe('resolveOwnedAttachments — the cap is applied before the work, not after', () => {
  const oversized = (n: number) => Array.from({ length: n }, (_, i) => ({ photo_id: i + 1 }));

  it('refuses an over-cap array without querying for any of it', async () => {
    const repo = ownerOf(new Set(oversized(20000).map((a) => a.photo_id)));

    await expect(resolveOwnedAttachments(oversized(20000), 'ABC', repo)).rejects.toThrow(
      `You can attach at most ${MAX_ATTACHMENTS} photos.`
    );

    // The whole point. A cap that lets the queries run first is not a cap.
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('refuses at one over the cap, and accepts exactly the cap', async () => {
    const atCap = oversized(MAX_ATTACHMENTS);
    const overCap = oversized(MAX_ATTACHMENTS + 1);
    const repo = ownerOf(new Set(overCap.map((a) => a.photo_id)));

    expect(await resolveOwnedAttachments(atCap, 'ABC', repo)).toEqual(atCap);
    await expect(resolveOwnedAttachments(overCap, 'ABC', repo)).rejects.toThrow();
  });

  it('carries no table name or prefix, because the message is a player-facing toast', async () => {
    // AGENTS.md §2.9: `ServiceEndpoint` puts `error.message` on the wire and `useAppAction`
    // shows it in a toast.
    const repo = ownerOf(new Set());
    await expect(
      resolveOwnedAttachments(oversized(MAX_ATTACHMENTS + 1), 'ABC', repo)
    ).rejects.toThrow(/^You can attach at most \d+ photos\.$/);
  });

  it('collapses a repeated id to one lookup and one attachment', async () => {
    const repo = ownerOf(new Set([7]));

    const result = await resolveOwnedAttachments(
      [{ photo_id: 7 }, { photo_id: 7 }, { photo_id: 7 }],
      'ABC',
      repo
    );

    expect(result).toEqual([{ photo_id: 7 }]);
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('bounds the dropped-attachment log along with the queries', async () => {
    // The warn is per unowned id, so capping the input caps the log an attacker can grow.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = ownerOf(new Set());

    await resolveOwnedAttachments(oversized(MAX_ATTACHMENTS), 'ABC', repo);

    expect(warn.mock.calls.length).toBeLessThanOrEqual(MAX_ATTACHMENTS);
    warn.mockRestore();
  });
});
