// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, SchemaRepository } from '../lib/defineService';
import { NotificationItem } from '@mica/shared/types';
import { Database } from '../lib/Database';
import { notificationsContract } from '@mica/shared/contracts/notifications';
import { phoneForCitizen } from '../lib/phoneIdentity';

export class NotificationsRepository extends SchemaRepository<NotificationItem> {
  /**
   * Unscoped batch create for background persistent pushes to online and offline recipients.
   *
   * Each row lands on the phone its recipient is on (MICA-282) — `phoneForCitizen`: the one
   * in their hand, or the one they used last, or their identity phone. A recipient whose
   * phone cannot be resolved is skipped and logged rather than written with none, because a
   * notification on no phone is one no phone ever shows.
   */
  async createNotificationBatch(items: Partial<NotificationItem>[]): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      let phoneId: string;
      try {
        phoneId = await phoneForCitizen(String(item.citizenid ?? ''));
      } catch (error) {
        console.error(`[mica] no phone to notify ${item.citizenid} on; dropping the row.`, error);
        continue;
      }
      await Database.query(
        `INSERT INTO mica_notifications (citizenid, phone_id, app, kind, title, body, avatar, deep_link, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
        [
          item.citizenid,
          phoneId,
          item.app,
          item.kind ?? 'general',
          item.title ?? item.app,
          item.body ?? '',
          item.avatar ?? null,
          item.deep_link ?? null
        ]
      );
    }
  }

  async findShadeNotifications(
    citizenid: string,
    phoneId: string,
    limit = 50
  ): Promise<NotificationItem[]> {
    return await Database.query<NotificationItem[]>(
      `SELECT * FROM mica_notifications
       WHERE citizenid = ? AND phone_id = ? AND cleared_at IS NULL AND status = 'active'
       ORDER BY id DESC LIMIT ?`,
      [citizenid, phoneId, limit]
    );
  }

  async findNotificationHistory(
    citizenid: string,
    phoneId: string,
    limit = 50
  ): Promise<NotificationItem[]> {
    return await Database.query<NotificationItem[]>(
      `SELECT * FROM mica_notifications
       WHERE citizenid = ? AND phone_id = ? AND cleared_at IS NOT NULL AND status = 'active'
       ORDER BY cleared_at DESC LIMIT ?`,
      [citizenid, phoneId, limit]
    );
  }

  async findUnreadCounts(citizenid: string, phoneId: string): Promise<Record<string, number>> {
    const rows = await Database.query<{ app: string; unread: number }[]>(
      `SELECT app, COUNT(*) as unread FROM mica_notifications
       WHERE citizenid = ? AND phone_id = ? AND read_at IS NULL AND cleared_at IS NULL AND status = 'active'
       GROUP BY app`,
      [citizenid, phoneId]
    );
    const counts: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const row of rows) {
        counts[row.app] = Number(row.unread);
      }
    }
    return counts;
  }

  async markRead(citizenid: string, phoneId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET read_at = ?
       WHERE citizenid = ? AND phone_id = ? AND id IN (${placeholders}) AND read_at IS NULL`,
      [now, citizenid, phoneId, ...ids]
    );
    return true;
  }

  async clearNotifications(citizenid: string, phoneId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET cleared_at = ?
       WHERE citizenid = ? AND phone_id = ? AND id IN (${placeholders}) AND cleared_at IS NULL`,
      [now, citizenid, phoneId, ...ids]
    );
    return true;
  }

  async clearAll(citizenid: string, phoneId: string, appId?: string): Promise<boolean> {
    const now = new Date().toISOString();
    if (appId) {
      await Database.query(
        `UPDATE mica_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND phone_id = ? AND app = ? AND cleared_at IS NULL`,
        [now, citizenid, phoneId, appId]
      );
    } else {
      await Database.query(
        `UPDATE mica_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND phone_id = ? AND cleared_at IS NULL`,
        [now, citizenid, phoneId]
      );
    }
    return true;
  }

  async restoreNotifications(citizenid: string, phoneId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET cleared_at = NULL, read_at = NULL
       WHERE citizenid = ? AND phone_id = ? AND id IN (${placeholders})`,
      [citizenid, phoneId, ...ids]
    );
    return true;
  }

  async pruneStale(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await Database.query<{ affectedRows?: number }>(
      `DELETE FROM mica_notifications WHERE created_at < ?`,
      [cutoff]
    );
    return result && typeof result === 'object' && 'affectedRows' in result
      ? Number(result.affectedRows)
      : 0;
  }
}

let notificationsRepo: NotificationsRepository | null = null;

export const notifications = defineService<NotificationItem, typeof notificationsContract>({
  contract: notificationsContract,
  deviceOwned: true,
  id: 'notifications',
  access: { read: 'owner', write: 'server' },
  statuses: ['active', 'deleted', 'moderated'],
  paging: { pageSize: 30, maxPageSize: 60 },
  schema: {
    app: { type: 'string', length: 32, notNull: true, clientFilterable: true },
    kind: { type: 'string', length: 32, notNull: true },
    title: { type: 'string', length: 80, notNull: true },
    body: { type: 'string', length: 255, notNull: true },
    avatar: { type: 'string', length: 255 },
    deep_link: { type: 'text' },
    read_at: { type: 'string', length: 32 },
    cleared_at: { type: 'string', length: 32 }
  },
  indexes: [
    { name: 'citizenid_cleared_id', columns: ['citizenid', 'cleared_at', 'id'] },
    { name: 'citizenid_app_id', columns: ['citizenid', 'app', 'id'] },
    { name: 'citizenid_read', columns: ['citizenid', 'read_at'] }
  ],
  /**
   * Every read and write goes through a named action, so no generic one is registered.
   *
   * `write: 'server'` already keeps create and update off. `get` and `delete` were still
   * registered and nothing called them — the shade reads through `getShadeNotifications`
   * and clears through `clearNotifications`, both of which apply the `cleared_at` and
   * `read_at` semantics the generic path knows nothing about. A generic `delete` would
   * hard-drop a row the moderation flow expects to still be there.
   *
   * Registered means reachable: a modified client emits the net event directly, so the
   * absence of a route in front of it is not a control.
   */
  options: { disableGet: true, disableDelete: true },
  repositoryFactory: (resolved) => {
    notificationsRepo = new NotificationsRepository(resolved);
    return notificationsRepo;
  }
});

export const getNotificationsRepository = (): NotificationsRepository | null => notificationsRepo;

const app = notifications.app;

// Every handler below is scoped to the phone in the caller's hand as well as to them
// (MICA-282). The phone id is always present on a device-owned service — the endpoint
// refused the request otherwise — and the casts say so where the type cannot.
app.registerEvent(
  'getShadeNotifications',
  async (_source, _cbId, _data, citizenid, _p, phoneId) => {
    if (!notificationsRepo) return [];
    return await notificationsRepo.findShadeNotifications(citizenid, phoneId as string);
  }
);

app.registerEvent(
  'getNotificationHistory',
  async (_source, _cbId, _data, citizenid, _p, phoneId) => {
    if (!notificationsRepo) return [];
    return await notificationsRepo.findNotificationHistory(citizenid, phoneId as string);
  }
);

app.registerEvent('getUnreadCounts', async (_source, _cbId, _data, citizenid, _p, phoneId) => {
  if (!notificationsRepo) return {};
  return await notificationsRepo.findUnreadCounts(citizenid, phoneId as string);
});

app.registerEvent('markAsRead', async (_source, _cbId, data, citizenid, _p, phoneId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.markRead(citizenid, phoneId as string, data.ids);
});

app.registerEvent('clearNotifications', async (_source, _cbId, data, citizenid, _p, phoneId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.clearNotifications(citizenid, phoneId as string, data.ids);
});

app.registerEvent('clearAllNotifications', async (_source, _cbId, data, citizenid, _p, phoneId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.clearAll(citizenid, phoneId as string, data.appId);
});

app.registerEvent('restoreNotifications', async (_source, _cbId, data, citizenid, _p, phoneId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.restoreNotifications(citizenid, phoneId as string, data.ids);
});

// Prune stale notifications on resource start
const getRetentionDays = (): number => {
  if (typeof GetConvarInt === 'function') {
    const val = GetConvarInt('mica_notification_retention', 30);
    return val > 0 ? val : 30;
  }
  return 30;
};

getNotificationsRepository()
  ?.pruneStale(getRetentionDays())
  .catch(() => {});
