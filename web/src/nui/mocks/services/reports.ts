// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Report } from '@mica/shared/types';
import { mockDarkchatMembers, mockDarkchatMessages, myDarkchatMember } from '../darkchat';
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

let nextReportId = 100;

/**
 * A report on a Dark Chat message joins the queue the way the server files it (MICA-254): the
 * preview captured, the author's citizenid, and `reporter_label` — the reporter's alias in that
 * channel, read from their member row, never from the payload. Every other table is still the
 * fixed answer it was, so the one seeded report stays the only one the admin specs count.
 */
const fileDarkchatReport = (data: { targetId?: number; category?: string; note?: string }) => {
  const message = mockDarkchatMessages.find((m) => m.id === data.targetId);
  const reporter = message ? myDarkchatMember(message.channel_id) : undefined;
  if (!message || !reporter || message.bot || message.member_id === reporter.id) {
    throw new Error('That message cannot be reported.');
  }
  const author = mockDarkchatMembers.find((m) => m.id === message.member_id);
  const now = new Date().toISOString();
  const id = nextReportId++;
  mockReports.push({
    id,
    citizenid: 'PLAYER',
    target_table: 'mica_darkchat_messages',
    target_id: message.id,
    category: (data.category as Report['category'] | undefined) ?? 'other',
    note: data.note,
    resolution: 'pending',
    target_preview: message.body,
    target_author: author?.citizenid,
    reporter_label: reporter.alias,
    status: 'active',
    created_at: now,
    updated_at: now
  });
  return { ok: true, id };
};

export const mocks: Record<string, MockHandler> = {
  // Reports & moderation. Stateful, like the photo and mail mocks: resolving has to
  // actually empty the queue, or the browser cannot show what happens next and the undo
  // flow has nothing to undo.
  'reports:create': async (data?: {
    targetTable?: string;
    targetId?: number;
    category?: string;
    note?: string;
  }) =>
    data?.targetTable === 'mica_darkchat_messages' ? fileDarkchatReport(data) : { ok: true, id: 1 },
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
