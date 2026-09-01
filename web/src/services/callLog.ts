// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import type { PhoneCallLogEntry } from '@gphone/shared/types';
import { fetchNui } from '../nui/fetchNui';

/** The signed-in player's call history, newest first. */
export const callLog = writable<PhoneCallLogEntry[]>([]);

export async function loadCallLog(): Promise<void> {
  const { rows } = await fetchNui<{ rows: PhoneCallLogEntry[]; nextCursor: number | null }>(
    'getCallLog',
    {},
    { defaultValue: { rows: [], nextCursor: null } }
  );
  callLog.set(rows);
}
