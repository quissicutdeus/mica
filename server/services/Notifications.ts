import { defineService, SchemaRepository } from '../lib/defineService';
import { NotificationItem } from '@shared/types';
import { Database } from '../lib/Database';
import { fields, requirePositiveInt } from '../lib/payload';

export class NotificationsRepository extends SchemaRepository<NotificationItem> {
  /** Unscoped batch create for background persistent pushes to online and offline recipients. */
  async createNotificationBatch(items: Partial<NotificationItem>[]): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      await Database.query(
        `INSERT INTO gphone_notifications (citizenid, app, kind, title, body, avatar, deep_link, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
        [
          item.citizenid,
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

  async findShadeNotifications(citizenid: string, limit = 50): Promise<NotificationItem[]> {
    return await Database.query<NotificationItem[]>(
      `SELECT * FROM gphone_notifications
       WHERE citizenid = ? AND cleared_at IS NULL AND status = 'active'
       ORDER BY id DESC LIMIT ?`,
      [citizenid, limit]
    );
  }

  async findNotificationHistory(citizenid: string, limit = 50): Promise<NotificationItem[]> {
    return await Database.query<NotificationItem[]>(
      `SELECT * FROM gphone_notifications
       WHERE citizenid = ? AND cleared_at IS NOT NULL AND status = 'active'
       ORDER BY cleared_at DESC LIMIT ?`,
      [citizenid, limit]
    );
  }

  async findUnreadCounts(citizenid: string): Promise<Record<string, number>> {
    const rows = await Database.query<{ app: string; unread: number }[]>(
      `SELECT app, COUNT(*) as unread FROM gphone_notifications
       WHERE citizenid = ? AND read_at IS NULL AND cleared_at IS NULL AND status = 'active'
       GROUP BY app`,
      [citizenid]
    );
    const counts: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const row of rows) {
        counts[row.app] = Number(row.unread);
      }
    }
    return counts;
  }

  async markRead(citizenid: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE gphone_notifications
       SET read_at = ?
       WHERE citizenid = ? AND id IN (${placeholders}) AND read_at IS NULL`,
      [now, citizenid, ...ids]
    );
    return true;
  }

  async clearNotifications(citizenid: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE gphone_notifications
       SET cleared_at = ?
       WHERE citizenid = ? AND id IN (${placeholders}) AND cleared_at IS NULL`,
      [now, citizenid, ...ids]
    );
    return true;
  }

  async clearAll(citizenid: string, appId?: string): Promise<boolean> {
    const now = new Date().toISOString();
    if (appId) {
      await Database.query(
        `UPDATE gphone_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND app = ? AND cleared_at IS NULL`,
        [now, citizenid, appId]
      );
    } else {
      await Database.query(
        `UPDATE gphone_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND cleared_at IS NULL`,
        [now, citizenid]
      );
    }
    return true;
  }

  async restoreNotifications(citizenid: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE gphone_notifications
       SET cleared_at = NULL, read_at = NULL
       WHERE citizenid = ? AND id IN (${placeholders})`,
      [citizenid, ...ids]
    );
    return true;
  }

  async pruneStale(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await Database.query<{ affectedRows?: number }>(
      `DELETE FROM gphone_notifications WHERE created_at < ?`,
      [cutoff]
    );
    return result && typeof result === 'object' && 'affectedRows' in result
      ? Number(result.affectedRows)
      : 0;
  }
}

let notificationsRepo: NotificationsRepository | null = null;

export const notifications = defineService<NotificationItem>({
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

app.registerEvent('getShadeNotifications', async (_source, _cbId, _data, citizenid) => {
  return notificationsRepo ? await notificationsRepo.findShadeNotifications(citizenid) : [];
});

app.registerEvent('getNotificationHistory', async (_source, _cbId, _data, citizenid) => {
  return notificationsRepo ? await notificationsRepo.findNotificationHistory(citizenid) : [];
});

app.registerEvent('getUnreadCounts', async (_source, _cbId, _data, citizenid) => {
  return notificationsRepo ? await notificationsRepo.findUnreadCounts(citizenid) : {};
});

app.registerEvent('markAsRead', async (_source, _cbId, data, citizenid) => {
  if (!notificationsRepo) return true;
  const rawIds = fields(data).ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((id) => requirePositiveInt(id, 'notification id'))
    : [];
  return await notificationsRepo.markRead(citizenid, ids);
});

app.registerEvent('clearNotifications', async (_source, _cbId, data, citizenid) => {
  if (!notificationsRepo) return true;
  const rawIds = fields(data).ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((id) => requirePositiveInt(id, 'notification id'))
    : [];
  return await notificationsRepo.clearNotifications(citizenid, ids);
});

app.registerEvent('clearAllNotifications', async (_source, _cbId, data, citizenid) => {
  if (!notificationsRepo) return true;
  const appId = fields(data).appId ? String(fields(data).appId) : undefined;
  return await notificationsRepo.clearAll(citizenid, appId);
});

app.registerEvent('restoreNotifications', async (_source, _cbId, data, citizenid) => {
  if (!notificationsRepo) return true;
  const rawIds = fields(data).ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((id) => requirePositiveInt(id, 'notification id'))
    : [];
  return await notificationsRepo.restoreNotifications(citizenid, ids);
});

// Prune stale notifications on resource start
const getRetentionDays = (): number => {
  if (typeof GetConvarInt === 'function') {
    const val = GetConvarInt('gphone_notification_retention', 30);
    return val > 0 ? val : 30;
  }
  return 30;
};

getNotificationsRepository()
  ?.pruneStale(getRetentionDays())
  .catch(() => {});
