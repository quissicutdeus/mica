// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Report } from '@mica/shared/types';
import { mockDarkchatMembers, mockDarkchatMessages, myDarkchatMember } from '../darkchat';
import type { MockHandler } from '../registry';
import { mockDms, mockOwnedAccountIds } from '../social';
import { mockSparkProfiles } from '../spark';

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
 * channel, read from their member row, never from the payload. Spark profiles and direct
 * messages queue too (below); every other table is still the fixed answer it was, and no table
 * is seeded with a report, so the one seeded report stays the only one the admin specs count.
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

type ReportInput = { targetId?: number; category?: string; note?: string };

/** The mock's stand-in for an author's citizenid: the player is `PLAYER`, anyone else per account. */
const ownerOf = (accountId: number) =>
  mockOwnedAccountIds.has(accountId) ? 'PLAYER' : `CITIZEN_${accountId}`;

/**
 * Queue a report the way `Reports.ts` files it: a target the caller cannot see is "no longer
 * exists" (the same answer as a missing row), their own content is refused, and the preview
 * is captured at filing. No `reporter_label` — only Dark Chat derives one.
 */
const queueReport = (
  table: string,
  data: ReportInput,
  target: { id: number; author: string; preview: string | null } | undefined
) => {
  if (!target) throw new Error('That content no longer exists.');
  if (target.author === 'PLAYER') throw new Error('You cannot report your own content.');
  const now = new Date().toISOString();
  const id = nextReportId++;
  mockReports.push({
    id,
    citizenid: 'PLAYER',
    target_table: table,
    target_id: target.id,
    category: (data.category as Report['category'] | undefined) ?? 'other',
    note: data.note,
    resolution: 'pending',
    target_preview: target.preview ?? undefined,
    target_author: target.author,
    status: 'active',
    created_at: now,
    updated_at: now
  });
  return { ok: true, id };
};

/** A Spark profile (MICA-255), previewed by its bio as `reportable` declares. */
const fileSparkReport = (data: ReportInput) => {
  const profile = mockSparkProfiles.find((p) => p.id === data.targetId && p.status === 'active');
  return queueReport(
    'mica_spark',
    data,
    profile && { id: profile.id, author: ownerOf(profile.account_id), preview: profile.bio }
  );
};

/** A direct message, any app: visible only to its two ends, previewed by its body. */
const fileDmReport = (data: ReportInput) => {
  const dm = mockDms.find((d) => d.id === data.targetId && d.status === 'active');
  const visible =
    dm && (mockOwnedAccountIds.has(dm.from_account) || mockOwnedAccountIds.has(dm.to_account));
  return queueReport(
    'mica_blabber_dms',
    data,
    dm && visible ? { id: dm.id, author: ownerOf(dm.from_account), preview: dm.body } : undefined
  );
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
  }) => {
    switch (data?.targetTable) {
      case 'mica_darkchat_messages':
        return fileDarkchatReport(data);
      case 'mica_spark':
        return fileSparkReport(data);
      case 'mica_blabber_dms':
        return fileDmReport(data);
      default:
        return { ok: true, id: 1 };
    }
  },
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
