// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  balanceOf,
  booleanOf,
  exposes,
  moved,
  numberOr,
  removeInventoryItem,
  resource,
  stringOr,
  unidentified,
  type FrameworkAdapter,
  type FrameworkJob,
  type FrameworkPlayer
} from './runtime';
import {
  QB_OWNER_TABLE,
  qbActiveJob,
  qbFindOfflineByCitizenId,
  qbFindOfflineByCitizenIds,
  qbFindOfflineByPhone,
  qbPhoneNumber,
  qbSetDuty,
  qbSetPhone
} from './qb';

/**
 * Every job a qbx player holds, active one first (MICA-227).
 *
 * qbx_core is the one core with multi-job built in: `PlayerData.jobs` is `{ [name]: grade }`
 * (`server/player.lua:324`, `AddPlayerToJob`), and `PlayerData.job` is the active one in the
 * shape `qbActiveJob` reads (`server/player.lua:217`, `toPlayerJob`). The held-but-inactive
 * jobs carry only a grade, so their label, grade name, pay and boss flag come from the job
 * definition — `exports.qbx_core:GetJob(name)` (`server/groups.lua:273`), which answers
 * `{ label, defaultDuty, grades: { [level]: { name, payment, isboss } } }`.
 *
 * **A build without `GetJob` degrades to the one active job** rather than listing names with
 * nothing behind them; `jobSupport` says which it is. `onDuty` is `null` for every inactive
 * job because qbx keeps duty on `PlayerData.job` alone — there is nothing to read.
 */
const qbxJobs = (player: any): FrameworkJob[] => {
  const active = qbActiveJob(player?.PlayerData?.job);
  if (!active) return [];
  const jobs: FrameworkJob[] = [active];

  const held = player.PlayerData?.jobs;
  if (!held || typeof held !== 'object' || !exposes('qbx_core', 'GetJob')) return jobs;

  for (const name of Object.keys(held).sort()) {
    if (name === active.name) continue;
    const grade = numberOr(held[name], 0);
    const definition = resource('qbx_core').GetJob(name);
    const gradeDef = definition?.grades?.[grade];
    jobs.push({
      name,
      label: stringOr(definition?.label, name),
      grade,
      gradeLabel: stringOr(gradeDef?.name, String(grade)),
      salary: numberOr(gradeDef?.payment, 0),
      onDuty: null,
      isBoss: gradeDef?.isboss === true,
      active: false
    });
  }
  return jobs;
};

/**
 * Switch the active job, and prove it switched by reading `PlayerData.job.name` back.
 *
 * `exports.qbx_core:SetPlayerPrimaryJob(citizenid, name)` — `server/player.lua:238`. It only
 * switches to a job the player already holds, assigns `PlayerData.job` synchronously on the
 * same table `GetPlayer` handed us, and answers `true` or `false, err`. That second return is
 * dropped on the way into JS and the first is not believed either: the re-read is the answer.
 * A name not held is refused before the call, quietly — an ordinary answer, not a surprise.
 */
const qbxSetActiveJob = (player: any, citizenid: string, src: number, name: string): boolean => {
  const current = player?.PlayerData?.job?.name;
  if (current === name) return true;
  const held = player?.PlayerData?.jobs;
  if (!held || typeof held !== 'object' || !(name in held)) return false;
  if (!exposes('qbx_core', 'SetPlayerPrimaryJob')) return false;
  try {
    resource('qbx_core').SetPlayerPrimaryJob(citizenid, name);
  } catch (error) {
    console.error(`[FrameworkBridge] qbx_core.SetPlayerPrimaryJob for source ${src} threw:`, error);
    return false;
  }
  return player.PlayerData?.job?.name === name;
};

/**
 * `exports.qbx_core:SetJobDuty(source, onDuty)` — `server/player.lua:196`, which assigns
 * `PlayerData.job.onduty` synchronously before raising `QBCore:Server:SetDuty`. The player
 * method (`server/player.lua:806`) is the fallback for a build without the export, and both
 * are verified the same way: by reading the field back.
 */
const qbxSetDuty = (player: any, src: number, name: string, onDuty: boolean): boolean => {
  const job = player?.PlayerData?.job;
  if (!job || job.name !== name || typeof job.onduty !== 'boolean') return false;
  if (!exposes('qbx_core', 'SetJobDuty')) return qbSetDuty(player, src, name, onDuty);
  try {
    resource('qbx_core').SetJobDuty(src, onDuty);
  } catch (error) {
    console.error(`[FrameworkBridge] qbx_core.SetJobDuty for source ${src} threw:`, error);
    return false;
  }
  return booleanOf(player.PlayerData?.job?.onduty, 'PlayerData.job.onduty', src) === onDuty;
};

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
  const phone = qbPhoneNumber(citizenid, player) ?? undefined;
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
    /**
     * `exports.qbx_core:SetCharInfo(source, 'phone', value)` — verified against the installed
     * copy: it assigns `PlayerData.charinfo[key]` and persists through `UpdatePlayerData`, and
     * qbx's own `GetPlayerByPhone` reads that field, so every other resource follows. A build
     * without the export falls back to the qb-core player method, one name over.
     */
    setPhone: (number: string) => {
      if (exposes('qbx_core', 'SetCharInfo')) {
        resource('qbx_core').SetCharInfo(src, 'phone', number);
        return true;
      }
      return qbSetPhone(player, number);
    },
    getJobs: () => qbxJobs(player),
    setActiveJob: (name: string) => qbxSetActiveJob(player, citizenid, src, name),
    setDuty: (name: string, onDuty: boolean) => qbxSetDuty(player, src, name, onDuty),
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
  },

  // Probed live rather than remembered: `GetJob` is its own export, and a build without it
  // is the one-job case `qbxJobs` degrades to.
  jobSupport: () =>
    exposes('qbx_core', 'GetJob')
      ? { multiJob: true, duty: true, via: 'qbx_core PlayerData.jobs + GetJob' }
      : {
          multiJob: false,
          duty: true,
          via: 'qbx_core PlayerData.job (no GetJob export, so only the active job is listed)'
        }
};
