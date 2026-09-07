// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { numberFor, readCitizenIdByNumber } from '../phoneNumbers';
import {
  balanceOf,
  exposes,
  identityFromCharinfo,
  moved,
  offlineLookup,
  removeInventoryItem,
  resource,
  unidentified,
  type FrameworkAdapter,
  type FrameworkIdentity,
  type FrameworkPlayer,
  type OwnerTable
} from './runtime';

/**
 * qb-core, and the schema the whole qb family shares (MICA-197).
 *
 * `qbx_core` is a qb core: it keeps characters in the same `players(citizenid)` table with the
 * same `charinfo` JSON column, and `detectFramework` answers `'qb'` for both. So the three
 * offline lookups and the owner table live here and `qbx.ts` imports them, rather than being
 * written twice or hoisted into `runtime.ts` — which is meant to know about no framework at
 * all. What actually differs between the two is how a *loaded* player is fetched, which is the
 * adapter each file exports.
 */

/**
 * qb-core and qbx_core. Matches `schemaSql.OWNER_TABLE`, which the DDL points at.
 *
 * A frozen literal, because both fields are interpolated into SQL as identifiers and MySQL
 * cannot parameterize one (§2.9). Nothing outside this module may supply either.
 */
export const QB_OWNER_TABLE: OwnerTable = Object.freeze({
  table: 'players',
  column: 'citizenid'
});

/** The qb family's offline record: `players(citizenid)`, with the name inside `charinfo`. */
export const qbFindOfflineByCitizenId = async (
  citizenid: string
): Promise<FrameworkIdentity | null> =>
  await offlineLookup('the `players` lookup by citizenid', async () => {
    const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
      `SELECT ${QB_OWNER_TABLE.column}, charinfo FROM ${QB_OWNER_TABLE.table}
       WHERE ${QB_OWNER_TABLE.column} = ? LIMIT 1`,
      [citizenid]
    );
    if (!row?.citizenid) return null;
    return identityFromCharinfo(row.citizenid, row.charinfo);
  });

/** The same, for many, in one `IN (…)` (MICA-197). */
export const qbFindOfflineByCitizenIds = async (
  citizenids: readonly string[]
): Promise<Map<string, FrameworkIdentity>> => {
  const found = new Map<string, FrameworkIdentity>();
  const placeholders = citizenids.map(() => '?').join(', ');

  await offlineLookup('the `players` lookup by citizenid', async () => {
    const rows = await Database.query<{ citizenid: string; charinfo: unknown }[]>(
      `SELECT ${QB_OWNER_TABLE.column}, charinfo FROM ${QB_OWNER_TABLE.table}
       WHERE ${QB_OWNER_TABLE.column} IN (${placeholders})`,
      [...citizenids]
    );
    for (const row of rows) {
      if (!row?.citizenid) continue;
      found.set(row.citizenid, identityFromCharinfo(row.citizenid, row.charinfo));
    }
    return null;
  });

  return found;
};

/**
 * Who holds this number.
 *
 * **micaOS's own table first** (MICA-284): a number belongs to a phone, and the phone's row
 * names whoever used it last. `charinfo.phone` is a mirror micaOS writes back on every switch,
 * and it is deliberately left stale for a player whose phone was taken — so the mirror alone
 * would answer with the victim. The `charinfo` read stays as the fallback for a character
 * micaOS has no row for yet: a fresh install onto a server with existing characters, before
 * they have connected once and had their number adopted.
 */
export const qbFindOfflineByPhone = async (phone: string): Promise<FrameworkIdentity | null> => {
  const holder = await offlineLookup('the `mica_phone_numbers` lookup by number', () =>
    readCitizenIdByNumber(phone)
  );
  if (holder) {
    const identity = await qbFindOfflineByCitizenId(holder);
    if (identity) return { ...identity, phone };
  }

  return await offlineLookup('the `players` lookup by phone number', async () => {
    const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
      `SELECT ${QB_OWNER_TABLE.column}, charinfo FROM ${QB_OWNER_TABLE.table}
     WHERE JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.phone')) = ?
     LIMIT 1`,
      [phone]
    );
    if (!row?.citizenid) return null;
    return identityFromCharinfo(row.citizenid, row.charinfo);
  });
};

/**
 * The number a loaded qb player is on (MICA-284).
 *
 * micaOS's own cache first, because it is the source of truth and is filled by the sync
 * before the write-back lands; `charinfo.phone` second, because it is the mirror of the same
 * value and is all there is before the first sync, and forever on a build whose write-back
 * could not be made (see `writeBack` in `services/PhoneNumbers.ts`).
 */
export const qbPhoneNumber = (citizenid: string, player: any): string | null => {
  const cached = numberFor(citizenid);
  if (cached) return cached;
  const mirrored = player?.PlayerData?.charinfo?.phone;
  return mirrored === null || mirrored === undefined || mirrored === '' ? null : String(mirrored);
};

/**
 * Write a number back through qb-core's player object.
 *
 * `SetPlayerData(key, value)` assigns the key and calls `UpdatePlayerData`, which is what
 * persists `charinfo` and raises the client event other resources listen to. The `charinfo`
 * table is mutated in place and handed back rather than copied, because qb-core keeps
 * references to it and a copy would leave those pointing at the old number until the next
 * full load. False when the shape is not there, which `writeBack` reports once.
 */
export const qbSetPhone = (player: any, number: string): boolean => {
  const charinfo = player?.PlayerData?.charinfo;
  if (!charinfo || typeof charinfo !== 'object') return false;
  if (typeof player?.Functions?.SetPlayerData !== 'function') return false;
  charinfo.phone = number;
  player.Functions.SetPlayerData('charinfo', charinfo);
  return true;
};

/** A loaded qb-core player, or null. */
const qbPlayer = (src: number): FrameworkPlayer | null => {
  const QBCore = resource('qb-core').GetCoreObject();
  const player = QBCore?.Functions?.GetPlayer ? QBCore.Functions.GetPlayer(src) : null;
  if (!player) return null;
  const citizenid = player.PlayerData?.citizenid;
  if (!citizenid) return unidentified(src, 'qb-core');
  const phone = qbPhoneNumber(citizenid, player) ?? undefined;
  return {
    citizenid,
    source: src,
    phone,
    getMoney: (type: 'bank' | 'cash') =>
      player.Functions?.GetMoney
        ? balanceOf(player.Functions.GetMoney(type), 'GetMoney', src)
        : balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src),
    removeMoney: (type: 'bank' | 'cash', amount: number) =>
      player.Functions?.RemoveMoney
        ? moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src)
        : false,
    addMoney: (type: 'bank' | 'cash', amount: number) =>
      player.Functions?.AddMoney
        ? moved(player.Functions.AddMoney(type, amount), 'AddMoney', src)
        : false,
    setMeta: (key: string, value: any) => {
      if (player.Functions?.SetMetaData) {
        player.Functions.SetMetaData(key, value);
      } else if (player.PlayerData?.metadata) {
        player.PlayerData.metadata[key] = value;
      }
    },
    removeItem: (item: string, count: number) => {
      return removeInventoryItem(src, player, item, count);
    },
    setPhone: (number: string) => qbSetPhone(player, number),
    rawPlayer: player
  };
};

/**
 * The qb-core adapter.
 *
 * Asked **after** qbx in `detectFramework`'s order, matching what the single-file version did:
 * a server running both keeps qbx, which is the one whose `GetPlayer` it was reaching first.
 */
export const qbAdapter: FrameworkAdapter = {
  kind: 'qb',

  detect: () => exposes('qb-core', 'GetCoreObject'),

  // qb-core hangs everything off one `GetCoreObject`, so all three probes are that one.
  canGetPlayer: () => exposes('qb-core', 'GetCoreObject'),
  canListPlayers: () => exposes('qb-core', 'GetCoreObject'),

  getPlayer: qbPlayer,

  getAllPlayers: () => {
    const QBCore = resource('qb-core').GetCoreObject();
    return QBCore?.Functions?.GetQBPlayers ? QBCore.Functions.GetQBPlayers() : {};
  },

  ownerTable: () => QB_OWNER_TABLE,

  findOfflineByCitizenId: qbFindOfflineByCitizenId,
  findOfflineByCitizenIds: qbFindOfflineByCitizenIds,
  findOfflineByPhone: qbFindOfflineByPhone,

  /**
   * Probed before it is reached, not just before it is used.
   *
   * `FrameworkBridge.registerUsableItem` walks the adapters until one says it handled the
   * item, so this runs on servers that are not qb at all — where `resource('qb-core')` is
   * `undefined` and reaching for `GetCoreObject` on it throws. The throw would be caught by
   * the bridge's own `try`, which would then stop walking, and an ESX or standalone server
   * would silently never register anything.
   */
  registerUsableItem: (item, cb) => {
    if (!exposes('qb-core', 'GetCoreObject')) return false;

    const QBCore = resource('qb-core').GetCoreObject();
    if (!QBCore?.Functions?.CreateUseableItem) return false;
    QBCore.Functions.CreateUseableItem(item, cb);
    return true;
  }
};
