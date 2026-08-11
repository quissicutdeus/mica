// The server half of the settings service.
import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { PhoneSetting } from '@shared/types';
import { fields } from '../lib/payload';

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
  async findAllForPlayer(citizenid: string): Promise<PhoneSetting[]> {
    return await Database.query<PhoneSetting[]>(
      `SELECT * FROM gphone_settings WHERE citizenid = ? AND status = 'active'`,
      [citizenid]
    );
  }

  /**
   * Write one key.
   *
   * `ON DUPLICATE KEY UPDATE` against the unique `(citizenid, app, setting_key)` index,
   * rather than find-then-insert. Two rapid writes to the same key — which is what
   * dragging a slider produces — race in the find-then-insert form and the loser becomes
   * either a duplicate row or a lost write. The constraint decides, not the order the
   * two queries interleave in.
   */
  async put(citizenid: string, app: string, key: string, value: string): Promise<void> {
    await Database.query(
      `INSERT INTO gphone_settings (citizenid, app, setting_key, setting_value, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), status = 'active', updated_at = NOW()`,
      [citizenid, app, key, value]
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
      `SELECT citizenid, setting_value FROM gphone_settings
       WHERE app = ? AND setting_key = ? AND status = 'active' AND citizenid IN (${placeholders})`,
      [app, key, ...citizenids]
    );
    return new Map(rows.map((row) => [row.citizenid, row.setting_value]));
  }

  /** Remove one key. Hard delete: a tombstoned preference is not a preference. */
  async remove(citizenid: string, app: string, key: string): Promise<void> {
    await Database.query(
      `DELETE FROM gphone_settings WHERE citizenid = ? AND app = ? AND setting_key = ?`,
      [citizenid, app, key]
    );
  }

  /**
   * Remove a whole namespace, for `clearAppStorage`.
   *
   * Without this an uninstalled app's rows outlive it on the server and come back on the
   * next hydrate — which is exactly the resurrection bug `clearAppStorage`'s own comment
   * says it exists to prevent, moved one layer down.
   */
  async clearApp(citizenid: string, app: string): Promise<void> {
    await Database.query(`DELETE FROM gphone_settings WHERE citizenid = ? AND app = ?`, [
      citizenid,
      app
    ]);
  }
}

let settingsRepo: SettingsRepository | null = null;

export const settings = defineService<PhoneSetting>({
  id: 'settings',
  access: { read: 'owner', write: 'owner' },
  schema: {
    app: { type: 'string', length: 32, notNull: true },
    setting_key: { type: 'string', length: 64, notNull: true },
    setting_value: { type: 'text' }
  },
  /**
   * A constraint rather than an optimisation (§10). It is what makes the upsert above
   * safe; without it two writes in the same tick produce two rows for one preference and
   * the read picks whichever the engine returns first.
   */
  indexes: [
    { name: 'citizenid_app_key', columns: ['citizenid', 'app', 'setting_key'], unique: true }
  ],
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
const namespaceOf = (data: unknown): { app: string; key: string } => {
  const payload = fields(data);
  const appId = String(payload.app ?? '').trim();
  const key = String(payload.key ?? '').trim();

  if (!appId || appId.length > 32) throw new Error('That setting could not be saved.');
  if (!key || key.length > 64) throw new Error('That setting could not be saved.');

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

app.registerEvent('getAll', async (_source, _cbId, _data, citizenid) => {
  return settingsRepo ? await settingsRepo.findAllForPlayer(citizenid) : [];
});

app.registerEvent('set', async (_source, _cbId, data, citizenid) => {
  if (!settingsRepo) return false;
  const { app: appId, key } = namespaceOf(data);

  // Already JSON when it leaves `useStorage`. Stringified again here only if a caller
  // handed us something else, so the column always holds one parseable value.
  const raw = fields(data).value;
  const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);

  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error('That setting is too large to save.');
  }

  await settingsRepo.put(citizenid, appId, key, value);
  return true;
});

app.registerEvent('remove', async (_source, _cbId, data, citizenid) => {
  if (!settingsRepo) return false;
  const { app: appId, key } = namespaceOf(data);
  await settingsRepo.remove(citizenid, appId, key);
  return true;
});

app.registerEvent('clearApp', async (_source, _cbId, data, citizenid) => {
  if (!settingsRepo) return false;
  const appId = String(fields(data).app ?? '').trim();
  if (!appId || appId.length > 32) throw new Error('That app could not be cleared.');
  await settingsRepo.clearApp(citizenid, appId);
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
  emitNet('gphone:client:settings:rehydrate', src);
};

const sourceOf = (player: any): number | undefined =>
  typeof player === 'number' ? player : player?.PlayerData?.source;

on('QBCore:Server:OnPlayerLoaded', (player: any) => {
  const src = sourceOf(player);
  if (src) pushRehydrate(src);
});

on('qbx_core:server:playerLoaded', (player: any) => {
  const src = sourceOf(player);
  if (src) pushRehydrate(src);
});
