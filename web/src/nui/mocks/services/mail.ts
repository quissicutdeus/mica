// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Mail } from '@mica/shared/types';
import { mockEmails } from '../data';
import { defineMockCrud } from '../defineMockCrud';
import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // Mail
  ...defineMockCrud<Mail>(
    mockEmails,
    { list: 'mail:getMail', remove: 'mail:deleteMail' },
    { remove: 'soft', visible: (e) => e.status !== 'deleted' }
  ),
  'mail:markAsRead': async (data: { id: number }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.read = true;
    return true;
  },
  'mail:archiveMail': async (data: { id: number; archive?: boolean }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.status = data.archive === false ? 'active' : 'archived';
    return true;
  }
};
