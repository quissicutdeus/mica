// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
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

/** Who holds this number, out of `charinfo`. The one framework that keeps a phone in core. */
export const qbFindOfflineByPhone = async (phone: string): Promise<FrameworkIdentity | null> =>
  await offlineLookup('the `players` lookup by phone number', async () => {
    const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
      `SELECT ${QB_OWNER_TABLE.column}, charinfo FROM ${QB_OWNER_TABLE.table}
     WHERE JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.phone')) = ?
     LIMIT 1`,
      [phone]
    );
    if (!row?.citizenid) return null;
    return identityFromCharinfo(row.citizenid, row.charinfo);
  });

/** A loaded qb-core player, or null. */
const qbPlayer = (src: number): FrameworkPlayer | null => {
  const QBCore = resource('qb-core').GetCoreObject();
  const player = QBCore?.Functions?.GetPlayer ? QBCore.Functions.GetPlayer(src) : null;
  if (!player) return null;
  const citizenid = player.PlayerData?.citizenid;
  if (!citizenid) return unidentified(src, 'qb-core');
  const phone = player.PlayerData?.charinfo?.phone || null;
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
