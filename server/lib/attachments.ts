// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requirePositiveInt } from './payload';
import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
import { PlayerFacingError } from './errors';

/**
 * Keep only the attachments whose photo the sender actually owns.
 *
 * A `photo_id` is a client-supplied row id, so an unchecked one lets a player attach —
 * and thereby disclose — someone else's photo (§2.9). Lifted out of `Messages.ts` once
 * Blabber needed the same check for post attachments: two copies of "trust nothing about
 * this id" is how one of them drifts.
 *
 * **The length check comes first, and that ordering is the fix.** This loop issues one
 * sequential `findById` per element, and `fields()` bounds nothing, so the array arrived
 * here at whatever length a modified client cared to send: `attachments: [{photo_id:1} x
 * 20000]` was 20,000 sequential queries inside one net event, plus a `console.warn` per
 * dropped id — a log an attacker could grow without bound, which `netGuard` already treats
 * as a denial of service in its own right. Capping the *result*, as Marketplace did, bounds
 * neither. The rate limiter does not help: it keys per action rather than per player and
 * nothing decrements on completion, so it permits 60 concurrent of these per action across
 * three services (MICA-131/132).
 *
 * **Refused rather than truncated, on count.** No legitimate client can exceed the cap —
 * the composer will not offer a fifth photo — so an over-long array is a broken or modified
 * client, and silently keeping the first four would hide the former from whoever wrote it.
 * The message is a player-facing toast, so it carries no table name and no prefix (§2.9).
 *
 * **An individual unowned id is still dropped quietly, which is a different question.** A
 * count is a mistake worth reporting; an id the sender does not own is almost always a probe,
 * and telling a prober which ids exist is the disclosure this helper is here to prevent. That
 * log is now bounded by the cap, so it stays.
 *
 * Duplicates collapse before any query runs: the same photo attached twice is one row and
 * one lookup, not two.
 */
export const resolveOwnedAttachments = async (
  raw: unknown,
  citizenid: string,
  photoRepo: { findById(id: number, citizenid: string): Promise<unknown | null> }
): Promise<{ photo_id: number }[]> => {
  if (!Array.isArray(raw)) return [];

  // Before the loop, and before anything is parsed: the only check an attacker cannot make
  // expensive is the one that reads a length.
  if (raw.length > MAX_ATTACHMENTS) {
    throw new PlayerFacingError(`You can attach at most ${MAX_ATTACHMENTS} photos.`, {
      key: 'server.attachments.tooMany',
      params: { max: MAX_ATTACHMENTS }
    });
  }

  const seen = new Set<number>();
  const owned: { photo_id: number }[] = [];
  for (const attachment of raw) {
    let photoId: number;
    try {
      photoId = requirePositiveInt((attachment as { photo_id?: unknown })?.photo_id, 'photo');
    } catch {
      continue;
    }
    if (seen.has(photoId)) continue;
    seen.add(photoId);

    const photo = await photoRepo.findById(photoId, citizenid);
    if (photo) {
      owned.push({ photo_id: photoId });
    } else {
      console.warn(`[attachments] Dropped attachment ${photoId} not owned by ${citizenid}.`);
    }
  }
  return owned;
};
