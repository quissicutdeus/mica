// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  balanceOf,
  exposes,
  moved,
  removeInventoryItem,
  resource,
  unidentified,
  type FrameworkAdapter,
  type FrameworkPlayer
} from './runtime';
import {
  QB_OWNER_TABLE,
  qbFindOfflineByCitizenId,
  qbFindOfflineByCitizenIds,
  qbFindOfflineByPhone
} from './qb';

/**
 * qbx_core (MICA-197).
 *
 * A qb core, so everything about the *schema* — `players(citizenid)`, the `charinfo` JSON
 * column, the owner table the orphan sweep compares against — comes from `qb.ts` rather than
 * being written a second time here, and `detectFramework` answers `'qb'` for both. What is
 * genuinely qbx's own is how a loaded player is fetched and where its money calls live: qbx
 * exposes `GetMoney`/`AddMoney`/`SetMetaData` on the resource as well as on the player object,
 * and qb-core does not.
 */

/** A loaded qbx_core player, or null. */
const qbxPlayer = (src: number): FrameworkPlayer | null => {
  const player = resource('qbx_core').GetPlayer(src);
  if (!player) return null;
  const citizenid = player.PlayerData?.citizenid || player.citizenid;
  if (!citizenid) return unidentified(src, 'qbx_core');
  const phone = player.PlayerData?.charinfo?.phone || null;
  return {
    citizenid,
    source: src,
    phone,
    getMoney: (type: 'bank' | 'cash') => {
      if (player.Functions?.GetMoney)
        return balanceOf(player.Functions.GetMoney(type), 'GetMoney', src);
      if (resource('qbx_core')?.GetMoney)
        return balanceOf(resource('qbx_core').GetMoney(src, type), 'qbx_core.GetMoney', src);
      // The player table, which is data rather than a call, and just as capable of
      // holding a string where a number is declared.
      return balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src);
    },
    removeMoney: (type: 'bank' | 'cash', amount: number) => {
      if (player.Functions?.RemoveMoney)
        return moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src);
      return false;
    },
    addMoney: (type: 'bank' | 'cash', amount: number) => {
      if (player.Functions?.AddMoney)
        return moved(player.Functions.AddMoney(type, amount), 'AddMoney', src);
      if (resource('qbx_core')?.AddMoney)
        return moved(resource('qbx_core').AddMoney(src, type, amount), 'qbx_core.AddMoney', src);
      return false;
    },
    setMeta: (key: string, value: any) => {
      if (player.Functions?.SetMetaData) {
        player.Functions.SetMetaData(key, value);
      } else if (player.PlayerData?.metadata) {
        player.PlayerData.metadata[key] = value;
      }
      try {
        if (resource('qbx_core')?.SetMetaData) {
          resource('qbx_core').SetMetaData(src, key, value);
        }
      } catch {
        // ignore
      }
    },
    removeItem: (item: string, count: number) => {
      return removeInventoryItem(src, player, item, count);
    },
    rawPlayer: player
  };
};

/**
 * The qbx_core adapter, and the **first** `detectFramework` asks.
 *
 * That order is a compatibility decision rather than a preference: a server running qbx_core
 * beside es_extended keeps the identity it already has rows under, because switching a live
 * server's citizenid scheme is a data migration and not a fallback.
 */
export const qbxAdapter: FrameworkAdapter = {
  kind: 'qb',

  detect: () => exposes('qbx_core', 'GetPlayer'),

  canGetPlayer: () => exposes('qbx_core', 'GetPlayer'),

  getPlayer: qbxPlayer,

  // A **different export** from `GetPlayer`, and probed separately for that reason: a
  // build exposing one and not the other must keep answering as it always did.
  canListPlayers: () => exposes('qbx_core', 'GetQBPlayers'),

  getAllPlayers: () => resource('qbx_core').GetQBPlayers() || {},

  ownerTable: () => QB_OWNER_TABLE,

  findOfflineByCitizenId: qbFindOfflineByCitizenId,
  findOfflineByCitizenIds: qbFindOfflineByCitizenIds,
  findOfflineByPhone: qbFindOfflineByPhone,

  registerUsableItem: (item, cb) => {
    if (!exposes('qbx_core', 'CreateUseableItem')) return false;
    resource('qbx_core').CreateUseableItem(item, cb);
    return true;
  }
};
