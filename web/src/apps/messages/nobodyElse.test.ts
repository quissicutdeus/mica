// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { Participant } from '@mica/shared/types';
import { nobodyElse } from './nobodyElse';

const member = (id: number, self: boolean): Participant => ({
  id,
  conversation_id: 1,
  role: self ? 'admin' : 'member',
  status: 'active',
  last_read: '2026-10-15T00:00:00Z',
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
  self,
  phone: self ? '867-5309' : '555-0133'
});

describe('nobodyElse (MICA-349)', () => {
  it('a 1:1 the other side left holds only the reader, so nobody else is in it', () => {
    expect(
      nobodyElse({ is_group: false, participants: [member(1, true)], participant_count: 1 })
    ).toBe(true);
  });

  /**
   * A 1:1 started to a number nobody holds: nobody ever left it, there was never anyone. Same
   * shape on the wire, and the same refusal on send, which is why the notice says "no one else"
   * rather than "they left".
   */
  it('a 1:1 started to a number nobody holds is one nobody else is in', () => {
    const solo = { ...member(7, true), conversation_id: 7 };
    expect(nobodyElse({ is_group: false, participants: [solo], participant_count: 1 })).toBe(true);
  });

  it('still reads as empty when the count is absent', () => {
    expect(nobodyElse({ is_group: false, participants: [member(1, true)] })).toBe(true);
  });

  it('a live 1:1 keeps its composer', () => {
    expect(
      nobodyElse({
        is_group: false,
        participants: [member(1, true), member(2, false)],
        participant_count: 2
      })
    ).toBe(false);
  });

  /**
   * The case this helper exists to get right: a thread with a line has no participant row for
   * the line, so its live members are the reader alone — exactly the shape of an empty 1:1. Only
   * its name, which `conversationForReader` sends on a non-group thread solely for a line, says
   * otherwise.
   */
  it('a thread with a line is never mistaken for an empty 1:1', () => {
    expect(
      nobodyElse({
        is_group: false,
        name: 'LSPD Dispatch',
        participants: [member(1, true)],
        participant_count: 1
      })
    ).toBe(false);
  });

  it('a group down to the reader is not a 1:1', () => {
    expect(
      nobodyElse({ is_group: true, participants: [member(1, true)], participant_count: 1 })
    ).toBe(false);
  });

  it('a thread with no membership yet (a fresh create reply) keeps its composer', () => {
    expect(nobodyElse({ is_group: false })).toBe(false);
    expect(nobodyElse({ is_group: false, participants: [] })).toBe(false);
  });

  it('a count that disagrees with the list is not taken as empty', () => {
    expect(
      nobodyElse({ is_group: false, participants: [member(1, true)], participant_count: 2 })
    ).toBe(false);
  });
});
