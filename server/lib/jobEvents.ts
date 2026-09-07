// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { appEventChannel } from './appEvents';

/**
 * A job changed under a player; tell their Jobs app to look again (MICA-227).
 *
 * Every framework raises an in-process event when a player's job, grade or duty changes.
 * This listens to each and pushes one `jobs:changed` to the player it names, with no
 * payload: a push carries a reference and the app refetches (`nui-endpoint`), and the
 * framework's own job object is the one thing this module has no business reshaping.
 *
 * **Local `on(...)`, never `onNet`** — the reasoning `PLAYER_LOADED_EVENTS.esxLocal` gives in
 * `lib/shell.ts`. Every one of these is a `TriggerEvent` from the core's server half, so no
 * client can raise it; registering only `on` leaves the name un-net-safe inside micaOS and
 * keeps it that way. An `onNet` twin added "to be safe" would let any connected client push a
 * refetch onto any player — a new entry point, and one `docs/security.md`'s framework-named
 * census would have to carry. The `src` in the payload is trusted for the same reason: it
 * was written by the core, not by a client.
 *
 * Argument order, verified against qbx_core (vendored):
 * - `QBCore:Server:OnJobUpdate` `(source, job)` — `server/player.lua:266` (a primary-job
 *   switch) and `:1009` (a job removed under the player). qb-core raises the same name.
 * - `QBCore:Server:SetDuty` `(source, onDuty)` — `server/player.lua:205`.
 * - `qbx_core:server:onGroupUpdate` `(source, groupName, grade?)` — `server/player.lua:326`
 *   and `:373` for jobs, `:536` and `:593` for gangs. A gang change reaches here too; the
 *   app refetches and sees nothing different, which is the cheapest correct answer.
 * - `esx:setJob` `(playerId, job, lastJob)` — es_extended's `xPlayer.setJob`. **Not verified
 *   against source**: es_extended is not vendored on this server; the order is from its
 *   published documentation, and only the first argument is read either way.
 *
 * `groups.lua:114`'s `qbx_core:server:onJobUpdate` is a different event — a job *definition*
 * changed for everybody, carrying a name and no source — and is not listened to: what a
 * player sees of their own job is refetched next time the app comes forward.
 */

/** The events, in one place, so `jobEvents.test.ts` fires the real names. */
export const JOB_CHANGE_EVENTS = {
  qbJobUpdate: 'QBCore:Server:OnJobUpdate',
  qbSetDuty: 'QBCore:Server:SetDuty',
  qbxGroupUpdate: 'qbx_core:server:onGroupUpdate',
  esxSetJob: 'esx:setJob'
} as const;

/**
 * Push a refetch to the player a framework event names.
 *
 * Never throws: this runs inside the core's own `TriggerEvent`, and an exception here is the
 * core's job update failing halfway through for a phone's sake. A source that is not a
 * positive integer, or one the framework will not name, is dropped quietly — the core said
 * who it meant, and if it cannot be resolved there is no phone to tell.
 */
export const notifyJobChanged = (rawSource: unknown): void => {
  try {
    const src = typeof rawSource === 'string' ? Number(rawSource) : rawSource;
    if (typeof src !== 'number' || !Number.isInteger(src) || src <= 0) return;
    const citizenid = FrameworkBridge.getCitizenId(src);
    if (!citizenid) return;
    appEventChannel('jobs').push(citizenid, 'changed', {});
  } catch (error) {
    console.error('[jobEvents] Failed to push a job change:', error);
  }
};

on(JOB_CHANGE_EVENTS.qbJobUpdate, (src: unknown) => notifyJobChanged(src));
on(JOB_CHANGE_EVENTS.qbSetDuty, (src: unknown) => notifyJobChanged(src));
on(JOB_CHANGE_EVENTS.qbxGroupUpdate, (src: unknown) => notifyJobChanged(src));
on(JOB_CHANGE_EVENTS.esxSetJob, (playerId: unknown) => notifyJobChanged(playerId));
