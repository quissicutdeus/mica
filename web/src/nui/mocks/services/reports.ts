// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Report } from '@mica/shared/types';
import type { MockHandler } from '../registry';

const mockReports: Report[] = [
  {
    id: 1,
    citizenid: 'REPORTER',
    target_table: 'mica_messages',
    target_id: 4,
    category: 'harassment',
    note: 'Kept messaging after I asked them to stop.',
    resolution: 'pending',
    target_preview: 'you are going to regret that',
    target_author: 'AUTHOR1',
    status: 'active',
    created_at: '2026-07-30T10:00:00Z',
    updated_at: '2026-07-30T10:00:00Z'
  }
];

export const mocks: Record<string, MockHandler> = {
  // Reports & moderation. Stateful, like the photo and mail mocks: resolving has to
  // actually empty the queue, or the browser cannot show what happens next and the undo
  // flow has nothing to undo.
  'reports:create': async () => ({ ok: true, id: 1 }),
  'reports:queue': async () => mockReports.filter((r) => r.resolution === 'pending'),
  'reports:history': async () => mockReports.filter((r) => r.resolution !== 'pending'),
  'reports:resolve': async (data?: { id?: number; action?: string }) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = data?.action === 'moderate' ? 'actioned' : 'dismissed';
    return { ok: true, resolution: report?.resolution };
  },
  'reports:reopen': async (data?: { id?: number }) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = 'pending';
    return { ok: true, resolution: 'pending' };
  }
};
