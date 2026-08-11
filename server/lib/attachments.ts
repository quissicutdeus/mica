import { requirePositiveInt } from './payload';

/**
 * Keep only the attachments whose photo the sender actually owns.
 *
 * A `photo_id` is a client-supplied row id, so an unchecked one lets a player attach —
 * and thereby disclose — someone else's photo (§2.9). Lifted out of `Messages.ts` once
 * Blabber needed the same check for post attachments: two copies of "trust nothing about
 * this id" is how one of them drifts.
 */
export const resolveOwnedAttachments = async (
  raw: unknown,
  citizenid: string,
  photoRepo: { findById(id: number, citizenid: string): Promise<unknown | null> }
): Promise<{ photo_id: number }[]> => {
  if (!Array.isArray(raw)) return [];

  const owned: { photo_id: number }[] = [];
  for (const attachment of raw) {
    let photoId: number;
    try {
      photoId = requirePositiveInt((attachment as { photo_id?: unknown })?.photo_id, 'photo id');
    } catch {
      continue;
    }

    const photo = await photoRepo.findById(photoId, citizenid);
    if (photo) {
      owned.push({ photo_id: photoId });
    } else {
      console.warn(`[attachments] Dropped attachment ${photoId} not owned by ${citizenid}.`);
    }
  }
  return owned;
};
