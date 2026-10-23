// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The server half of the settings service.
import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { PhoneSetting } from '@mica/shared/types';
import { settingsContract } from '@mica/shared/contracts/settings';
import { onPlayerLoaded } from '../lib/shell';

/**
 * Every preference the phone holds, owned by a citizenid.
 *
 * It all lived in `localStorage`, which is per-PC and shared between characters: a theme
 * did not follow a player to another machine, and a second character on the same PC
 * inherited the first one's phone. `services/blabber.ts` already documented the second
 * half of that in a comment about `activeAccountId`.
 *
 * Key-value rather than one JSON document per player, for two reasons. It maps 1:1 onto
 * `useStorage(app).setItem(key, value)`, so the SDK gains no new concepts and no call
 * site changes. And per-key writes cannot clobber each other — a JSON blob is a
 * read-modify-write, so the theme store and the volume store saving in the same tick
 * lose one of the two.
 */
export class SettingsRepository extends SchemaRepository<PhoneSetting> {
  /**
   * Every setting a player has, in one query.
   *
   * The whole set rather than a page: it is a handful of rows of a few hundred bytes,
   * it is read exactly once per session, and the phone needs all of it before it paints.
   * Paging here would mean the theme arrives on page two.
   */
  async findAllForPlayer(citizenid: string, deviceId: string): Promise<PhoneSetting[]> {
    return await Database.query<PhoneSetting[]>(
      `SELECT * FROM mica_settings WHERE citizenid = ? AND device_id = ? AND status = 'active'`,
      [citizenid, deviceId]
    );
  }

  /**
   * Write one key.
   *
   * `ON DUPLICATE KEY UPDATE` against the unique `(live_device, app, setting_key)` index,
   * rather than find-then-insert. Two rapid writes to the same key — which is what
   * dragging a slider produces — race in the find-then-insert form and the loser becomes
   * either a duplicate row or a lost write. The constraint decides, not the order the
   * two queries interleave in.
   *
   * `citizenid` is written on the insert and **also on the update** (MICA-282): the row
   * belongs to the phone, and the phone to the citizen who first used it, for good (MICA-436).
   * Only that citizen's resolve reaches here, so the update changes nothing but a row a
   * handover before MICA-436 left naming somebody else.
   */
  async put(
    citizenid: string,
    deviceId: string,
    app: string,
    key: string,
    value: string
  ): Promise<void> {
    await Database.query(
      `INSERT INTO mica_settings (citizenid, device_id, app, setting_key, setting_value, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE citizenid = VALUES(citizenid), setting_value = VALUES(setting_value), status = 'active', updated_at = NOW()`,
      [citizenid, deviceId, app, key, value]
    );
  }

  /**
   * One setting for many players, in one query.
   *
   * Built for `server/lib/proximity.ts`'s visibility check: without it, filtering a
   * candidate list of nearby players to the Bluetooth-visible ones would be one query per
   * candidate, on a path that already fans out per share. Rows are keyed by citizenid; a
   * citizenid with no row is not in the returned map at all, so a caller decides what a
   * missing preference means rather than this method guessing on its behalf.
   */
  async getValuesFor(citizenids: string[], app: string, key: string): Promise<Map<string, string>> {
    if (citizenids.length === 0) return new Map();

    const placeholders = citizenids.map(() => '?').join(',');
    const rows = await Database.query<{ citizenid: string; setting_value: string }[]>(
      `SELECT citizenid, setting_value FROM mica_settings
       WHERE app = ? AND setting_key = ? AND status = 'active' AND citizenid IN (${placeholders})`,
      [app, key, ...citizenids]
    );
    return new Map(rows.map((row) => [row.citizenid, row.setting_value]));
  }

  /**
   * Remove one key: the row goes to `deleted` and stays (MICA-428). Every read asks for
   * `active`, and the next `put` of the key brings the row back under `live_device_app_key`.
   */
  async remove(citizenid: string, deviceId: string, app: string, key: string): Promise<void> {
    await Database.query(
      `UPDATE mica_settings SET status = 'deleted'
       WHERE citizenid = ? AND device_id = ? AND app = ? AND setting_key = ? AND status = 'active'`,
      [citizenid, deviceId, app, key]
    );
  }

  /**
   * Remove a whole namespace, for `clearAppStorage`.
   *
   * Without this an uninstalled app's rows outlive it on the server and come back on the
   * next hydrate — which is exactly the resurrection bug `clearAppStorage`'s own comment
   * says it exists to prevent, moved one layer down. `deleted`, never removed (MICA-428).
   */
  async clearApp(citizenid: string, deviceId: string, app: string): Promise<void> {
    await Database.query(
      `UPDATE mica_settings SET status = 'deleted'
       WHERE citizenid = ? AND device_id = ? AND app = ? AND status = 'active'`,
      [citizenid, deviceId, app]
    );
  }
}

let settingsRepo: SettingsRepository | null = null;

export const settings = defineService<PhoneSetting, typeof settingsContract>({
  contract: settingsContract,
  deviceOwned: true,
  // Both devices, each with rows of its own: a tablet's settings are its own (MICA-264).
  devices: ['phone', 'tablet'],
  id: 'settings',
  access: { read: 'owner', write: 'owner' },
  schema: {
    app: { type: 'string', length: 32, notNull: true },
    setting_key: { type: 'string', length: 64, notNull: true },
    setting_value: { type: 'text' },
    /**
     * The phone while the setting is not erased (MICA-428): what the key is over, so `put`
     * never revives or overwrites an erased setting and writes a fresh row beside it. A
     * `deleted` one still holds the key, and `put` brings it back. Restated, frozen, by
     * `0015_hidden_rows_are_kept`.
     */
    live_device: {
      type: 'string',
      length: 32,
      clientWritable: false,
      generatedAs: "CASE WHEN `status` <> 'erased' THEN `device_id` ELSE NULL END"
    }
  },
  /**
   * A constraint rather than an optimisation (§10). It is what makes the upsert above
   * safe; without it two writes in the same tick produce two rows for one preference and
   * the read picks whichever the engine returns first.
   *
   * `device_id` itself is injected by `deviceOwned` (MICA-282): a preference belongs to the
   * phone it was set on, and follows it.
   */
  indexes: [
    /**
     * Per phone since MICA-282 (`0002_phone_data_follows_the_phone` swaps the old
     * `citizenid_app_key` for it): a character with two phones has two themes, and the upsert
     * in `put` collides on this key and no other.
     */
    {
      name: 'live_device_app_key',
      columns: ['live_device', 'app', 'setting_key'],
      unique: true
    }
  ],
  uniqueAfterDelete: {
    optOut:
      'No generic create or delete: `put` is an INSERT … ON DUPLICATE KEY UPDATE that sets the ' +
      "row back to 'active', so the row `remove`/`clearApp` moved to 'deleted' comes back under " +
      'its key; an erased one holds no key (MICA-428).'
  },
  /**
   * No generic action survives. The client addresses a row by `(app, setting_key)` and
   * never by id, so `update` and `delete` have nothing to act on, `create` cannot express
   * the upsert, and `get` would answer a page when the phone needs the whole set.
   */
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  },
  repositoryFactory: (resolved) => {
    settingsRepo = new SettingsRepository(resolved);
    return settingsRepo;
  }
});

export const getSettingsRepository = (): SettingsRepository | null => settingsRepo;

const app = settings.app;

/**
 * Narrow a payload's namespace and key.
 *
 * Both are attacker-controlled (§2.9) and both are compared as **data**, never
 * interpolated, so the risk is not injection — it is a value too long for its column,
 * which MySQL truncates silently in non-strict mode. The message reaches the player
 * through `useAppAction`'s error toast, so it carries no table name and no `[Repository]`
 * prefix.
 */
const namespaceOf = (data: { app: string; key: string }): { app: string; key: string } => {
  const appId = data.app.trim();
  const key = data.key.trim();

  // The contract already refused anything longer than the column, so what is left to catch is
  // a value that was nothing but whitespace — length-legal and still not a namespace.
  if (!appId || !key)
    throw new PlayerFacingError('That setting could not be saved.', {
      key: 'server.settings.notSaved'
    });

  return { app: appId, key };
};

/**
 * How much one preference may be.
 *
 * Generous for a preference and far below what a wallpaper image would need — which is
 * deliberate. A custom wallpaper is a base64 data URL of unbounded size and stays local
 * (`sync: false`); this cap is what stops one arriving here by a route nobody intended
 * and putting megabytes into the table on every drag of a color picker.
 */
const MAX_VALUE_LENGTH = 8192;

// A device-owned service always has a phone id by the time a handler runs; the endpoint
// refused the request otherwise. The cast says so where the type cannot.
app.registerEvent('getAll', async (_source, _cbId, _data, citizenid, _player, deviceId) => {
  return settingsRepo ? await settingsRepo.findAllForPlayer(citizenid, deviceId as string) : [];
});

app.registerEvent('set', async (_source, _cbId, data, citizenid, _player, deviceId) => {
  if (!settingsRepo) return false;
  const { app: appId, key } = namespaceOf(data);

  // Already JSON when it leaves `useStorage`. Stringified again here only if a caller
  // handed us something else, so the column always holds one parseable value.
  const raw = data.value;
  const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);

  if (value.length > MAX_VALUE_LENGTH) {
    throw new PlayerFacingError('That setting is too large to save.', {
      key: 'server.settings.tooLarge'
    });
  }

  await settingsRepo.put(citizenid, deviceId as string, appId, key, value);
  return true;
});

app.registerEvent('remove', async (_source, _cbId, data, citizenid, _player, deviceId) => {
  if (!settingsRepo) return false;
  const { app: appId, key } = namespaceOf(data);
  await settingsRepo.remove(citizenid, deviceId as string, appId, key);
  return true;
});

app.registerEvent('clearApp', async (_source, _cbId, data, citizenid, _player, deviceId) => {
  if (!settingsRepo) return false;
  const appId = data.app.trim();
  if (!appId)
    throw new PlayerFacingError('That app could not be cleared.', {
      key: 'server.settings.appNotCleared'
    });
  await settingsRepo.clearApp(citizenid, deviceId as string, appId);
  return true;
});

/**
 * Tell a freshly loaded character's phone to re-read its settings.
 *
 * Mirrors `Battery.ts`, including listening for both cores' events, because the shape of
 * the player-loaded event differs between QBCore and qbx and neither is safe to assume.
 * The push carries nothing: the phone asks over the ordinary `getSettings` round trip,
 * which already scopes the read to the caller's citizenid.
 */
const pushRehydrate = (src: number): void => {
  if (typeof emitNet !== 'function') return;
  emitNet('mica:client:settings:rehydrate', src);
};

/**
 * One subscription, not a listener per framework event.
 *
 * This file used to register `QBCore:Server:OnPlayerLoaded` and its local twin itself, and
 * work out the target from the payload — the MICA-136 hole, made here and in two other
 * files because it had been copied. `lib/shell.ts` now owns every player-loaded entry point
 * and hands out a source it has already established, so this cannot get the identity wrong:
 * it is never shown a payload. Adding ESX cost this file nothing, which is the point.
 */
onPlayerLoaded('settings', pushRehydrate);
