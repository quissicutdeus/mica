// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPIRED } from '../lib/statuses';
import { defineService, SchemaRepository } from '../lib/defineService';
import { NotificationItem } from '@mica/shared/types';
import { Database } from '../lib/Database';
import { statusWritesMayRun } from '../lib/statusWrites';
import { whenSchemaReady } from '../lib/schemaReady';
import { notificationsContract } from '@mica/shared/contracts/notifications';
import { phoneForCitizen } from '../lib/deviceIdentity';
import { reasonOf, traceOf } from '../lib/sqlErrors';
import { who } from '../lib/who';
import { openRows, sealRow, storablePlaintext } from '../lib/contentCipher';

const TABLE = 'mica_notifications';
/** The plaintext bounds, in characters; the columns are as wide as these sealed. */
const TITLE_MAX = 80;
const BODY_MAX = 255;

/** At most `max` characters as MariaDB counts them — code points — never half a pair. */
const clip = (text: string, max: number): string => {
  const chars = Array.from(String(text));
  return chars.length <= max ? String(text) : chars.slice(0, max).join('');
};

/** What a failure is logged as when no line of it is safe to print. */
export const UNKNOWN_DB_ERROR = 'unknown database error';

/**
 * Why a notification write failed, safe to log: the driver's own last line, never the rest.
 *
 * oxmysql rejects with one message holding the whole statement **and its parameters** before
 * mysql2's reason on the last line, so logging the error as-is would print the notification's
 * body — a message preview, a mail subject — into the server console. `reasonOf` answers the
 * last line, and '' when mysql2's own message is empty (Node's dual-stack `ECONNREFUSED` is an
 * `AggregateError` with `message: ''`) and that line is therefore the parameters, the query or
 * oxmysql's header; the constant stands in for that, as it does for an error with no message.
 */
export const notificationFailureReason = (error: unknown): string =>
  reasonOf(error, UNKNOWN_DB_ERROR);

export class NotificationsRepository extends SchemaRepository<NotificationItem> {
  /**
   * Unscoped batch create for background persistent pushes to online and offline recipients.
   *
   * Each row lands on the phone its recipient is on (MICA-282) — `phoneForCitizen`: the one
   * in their hand, or the one they used last, or their identity phone. A recipient whose
   * phone cannot be resolved is skipped and logged rather than written with none, because a
   * notification on no phone is one no phone ever shows.
   *
   * One recipient's failed insert never costs the rest theirs (MICA-329): each is caught,
   * counted, and the batch goes on, with one line at the end naming how many failed and the
   * first reason. Never the body — see `notificationFailureReason`.
   */
  async createNotificationBatch(items: Partial<NotificationItem>[]): Promise<void> {
    if (items.length === 0) return;
    let failed = 0;
    let firstFailure: unknown;
    for (const item of items) {
      let deviceId: string;
      try {
        deviceId = await phoneForCitizen(String(item.citizenid ?? ''));
      } catch (error) {
        console.error(
          `[mica] no phone to notify ${who(item.citizenid)} on; dropping the row.`,
          traceOf(error)
        );
        continue;
      }
      try {
        // Sealed to the phone it lands on (MICA-431). Clipped to the column's bound first: a
        // sealed value too long for its column is truncated into a padlock, where plaintext
        // was only cut short. `storablePlaintext`, because the words are somebody else's.
        const sealed = await sealRow(TABLE, {
          citizenid: item.citizenid,
          device_id: deviceId,
          title: await storablePlaintext(clip(item.title ?? item.app ?? '', TITLE_MAX), TITLE_MAX),
          body: await storablePlaintext(clip(item.body ?? '', BODY_MAX), BODY_MAX)
        });
        await Database.query(
          `INSERT INTO mica_notifications (citizenid, device_id, app, kind, title, body, avatar, deep_link, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
          [
            item.citizenid,
            deviceId,
            item.app,
            item.kind ?? 'general',
            sealed.title,
            sealed.body,
            item.avatar ?? null,
            item.deep_link ?? null
          ]
        );
      } catch (error) {
        if (failed === 0) firstFailure = error;
        failed += 1;
      }
    }
    if (failed > 0) {
      const { app, kind } = items[0];
      console.error(
        `[mica] could not store ${failed} of ${items.length} '${app}:${kind ?? 'general'}' ` +
          `notification(s); the rest were stored. First error: ` +
          notificationFailureReason(firstFailure)
      );
    }
  }

  async findShadeNotifications(
    citizenid: string,
    deviceId: string,
    limit = 50
  ): Promise<NotificationItem[]> {
    return openRows(
      TABLE,
      await Database.query<NotificationItem[]>(
        `SELECT * FROM mica_notifications
         WHERE citizenid = ? AND device_id = ? AND cleared_at IS NULL AND status = 'active'
         ORDER BY id DESC LIMIT ?`,
        [citizenid, deviceId, limit]
      )
    );
  }

  async findNotificationHistory(
    citizenid: string,
    deviceId: string,
    limit = 50
  ): Promise<NotificationItem[]> {
    return openRows(
      TABLE,
      await Database.query<NotificationItem[]>(
        `SELECT * FROM mica_notifications
         WHERE citizenid = ? AND device_id = ? AND cleared_at IS NOT NULL AND status = 'active'
         ORDER BY cleared_at DESC LIMIT ?`,
        [citizenid, deviceId, limit]
      )
    );
  }

  async findUnreadCounts(citizenid: string, deviceId: string): Promise<Record<string, number>> {
    const rows = await Database.query<{ app: string; unread: number }[]>(
      `SELECT app, COUNT(*) as unread FROM mica_notifications
       WHERE citizenid = ? AND device_id = ? AND read_at IS NULL AND cleared_at IS NULL AND status = 'active'
       GROUP BY app`,
      [citizenid, deviceId]
    );
    const counts: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const row of rows) {
        counts[row.app] = Number(row.unread);
      }
    }
    return counts;
  }

  async markRead(citizenid: string, deviceId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET read_at = ?
       WHERE citizenid = ? AND device_id = ? AND id IN (${placeholders}) AND read_at IS NULL`,
      [now, citizenid, deviceId, ...ids]
    );
    return true;
  }

  async clearNotifications(citizenid: string, deviceId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET cleared_at = ?
       WHERE citizenid = ? AND device_id = ? AND id IN (${placeholders}) AND cleared_at IS NULL`,
      [now, citizenid, deviceId, ...ids]
    );
    return true;
  }

  async clearAll(citizenid: string, deviceId: string, appId?: string): Promise<boolean> {
    const now = new Date().toISOString();
    if (appId) {
      await Database.query(
        `UPDATE mica_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND device_id = ? AND app = ? AND cleared_at IS NULL`,
        [now, citizenid, deviceId, appId]
      );
    } else {
      await Database.query(
        `UPDATE mica_notifications
         SET cleared_at = ?
         WHERE citizenid = ? AND device_id = ? AND cleared_at IS NULL`,
        [now, citizenid, deviceId]
      );
    }
    return true;
  }

  async restoreNotifications(citizenid: string, deviceId: string, ids: number[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const placeholders = ids.map(() => '?').join(',');
    await Database.query(
      `UPDATE mica_notifications
       SET cleared_at = NULL, read_at = NULL
       WHERE citizenid = ? AND device_id = ? AND id IN (${placeholders})`,
      [citizenid, deviceId, ...ids]
    );
    return true;
  }

  /**
   * Expire the notifications past the window (MICA-428): `active` to `expired`, kept and hidden.
   * A `moderated` one, or one the player already cleared away to `deleted`, stays as it is.
   * `updated_at` is pinned: expiring is not an edit.
   */
  async pruneStale(retentionDays: number): Promise<number> {
    // Never before `micaschema apply` gives the ENUM `expired`: `sql_mode=''` would write ''.
    if (!(await statusWritesMayRun('the notification prune', { mica_notifications: [EXPIRED] }))) {
      return 0;
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await Database.query<{ affectedRows?: number }>(
      `UPDATE mica_notifications SET status = ?, updated_at = updated_at
       WHERE status = 'active' AND created_at < ?`,
      [EXPIRED, cutoff]
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
  // `expired`: the retention window passed (MICA-428), never a player's own delete.
  statuses: ['active', 'deleted', 'moderated', EXPIRED],
  paging: { pageSize: 30, maxPageSize: 60 },
  encryptionScope: [],
  schema: {
    app: { type: 'string', length: 32, notNull: true, clientFilterable: true },
    kind: { type: 'string', length: 32, notNull: true },
    /** Sealed at rest (MICA-431), bound to the phone the notification is on. */
    title: { type: 'string', length: TITLE_MAX, notNull: true, encrypted: true },
    body: { type: 'string', length: BODY_MAX, notNull: true, encrypted: true },
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
  async (_source, _cbId, _data, citizenid, _p, deviceId) => {
    if (!notificationsRepo) return [];
    return await notificationsRepo.findShadeNotifications(citizenid, deviceId as string);
  }
);

app.registerEvent(
  'getNotificationHistory',
  async (_source, _cbId, _data, citizenid, _p, deviceId) => {
    if (!notificationsRepo) return [];
    return await notificationsRepo.findNotificationHistory(citizenid, deviceId as string);
  }
);

app.registerEvent('getUnreadCounts', async (_source, _cbId, _data, citizenid, _p, deviceId) => {
  if (!notificationsRepo) return {};
  return await notificationsRepo.findUnreadCounts(citizenid, deviceId as string);
});

app.registerEvent('markAsRead', async (_source, _cbId, data, citizenid, _p, deviceId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.markRead(citizenid, deviceId as string, data.ids);
});

app.registerEvent('clearNotifications', async (_source, _cbId, data, citizenid, _p, deviceId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.clearNotifications(citizenid, deviceId as string, data.ids);
});

app.registerEvent(
  'clearAllNotifications',
  async (_source, _cbId, data, citizenid, _p, deviceId) => {
    if (!notificationsRepo) return true;
    return await notificationsRepo.clearAll(citizenid, deviceId as string, data.appId);
  }
);

app.registerEvent('restoreNotifications', async (_source, _cbId, data, citizenid, _p, deviceId) => {
  if (!notificationsRepo) return true;
  return await notificationsRepo.restoreNotifications(citizenid, deviceId as string, data.ids);
});

// Prune stale notifications on resource start
const getRetentionDays = (): number => {
  if (typeof GetConvarInt === 'function') {
    const val = GetConvarInt('mica_notification_retention', 30);
    return val > 0 ? val : 30;
  }
  return 30;
};

/**
 * Once the resource has started and the schema check has settled, never at import: a write at
 * import ran before anything knew whether the database was current, and on a server not yet
 * through `micaschema apply` it blanked the status of every old notification (the prune also
 * asks `statusWritesMayRun` itself). A failure is said, never swallowed.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;
  whenSchemaReady(async () => {
    try {
      await getNotificationsRepository()?.pruneStale(getRetentionDays());
    } catch (error) {
      console.error('[mica] the notification prune failed:', traceOf(error));
    }
  });
});
