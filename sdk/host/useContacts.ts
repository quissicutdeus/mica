// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function useContacts() {
  return guarded('useContacts').facets.contacts();
}
