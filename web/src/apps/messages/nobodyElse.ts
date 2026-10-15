// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Conversation } from '@mica/shared/types';

/**
 * Whether this is a 1:1 with nobody in it but the reader, so nothing sent into it can land
 * (MICA-349).
 *
 * Two ways to get one. Since MICA-342 the side that stays keeps a thread the other side left
 * (or was purged from by a privacy delete), readable. And a 1:1 started to a number nobody holds
 * has only ever had the reader. The server refuses a send into either, and the notice is worded
 * for both — "they left" would be false for the second. The phone works it out from what the
 * thread list already carries, with no field of its own:
 *
 * - **`participants` is live members only.** `findParticipantsForConversations` reads
 *   `left_at IS NULL`, and a privacy purge deletes the row outright, so either thread comes back
 *   holding the reader's own membership and nobody else's.
 * - **A thread with a line looks exactly like that too**, and must keep its composer. A line has
 *   no participant row (`openLineThread`), so its thread is also just the reader. What tells the
 *   two apart is `name`: `conversationForReader` sends a name on a non-group thread **only** when
 *   one side is a line, and a line's label is never empty (`publicApi.ts` falls back to the
 *   number). A 1:1 that is not with a line never carries one since MICA-339.
 * - **The reader's own membership must be present.** A thread the phone has just started gets no
 *   participants back from `create`, and an unknown shape is not evidence the thread is empty:
 *   without `self`, the composer stays.
 *
 * Fails toward the composer. A false positive hides the only way to reply; a missed one costs a
 * toast, because the server refuses the send either way.
 */
export const nobodyElse = (
  conv: Pick<Conversation, 'is_group' | 'name' | 'participants' | 'participant_count'>
): boolean => {
  if (conv.is_group || conv.name) return false;
  const members = conv.participants;
  if (!members || !members.some((member) => member.self)) return false;
  if (members.some((member) => !member.self)) return false;
  return conv.participant_count === undefined || conv.participant_count <= 1;
};
