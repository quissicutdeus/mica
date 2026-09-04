// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';
import { sendNuiMessage } from '../lib/nui';
import { DeviceState } from '../lib/DeviceState';
import { openDevice, closeDevice } from '../lib/DeviceVisibility';

/**
 * The device a payload names, or the phone (MICA-262). Every shell event carried no
 * device before the tablet, so absent has to keep meaning what it always did.
 */
const deviceOf = (payload: unknown): DeviceId => {
  const device = (payload as { device?: unknown } | null | undefined)?.device;
  return isDeviceId(device) ? device : DEFAULT_DEVICE;
};

/** Lower the device if a gate just closed on it while it was up. */
const closeIfDisabled = (id: DeviceId): void => {
  if (!DeviceState.isEnabled(id) && DeviceState.isOpen(id)) closeDevice(id);
};

/**
 * Shell-scoped client events — the ones that belong to the phone itself rather than to
 * any app.
 *
 * `shell` is the segment for these because the event name convention is
 * `mica:<side>:<app>:<action>` and there is no app here. It matches what the rest of
 * the codebase already calls this layer.
 */

/**
 * A server-originated toast.
 *
 * The server has emitted this since the ace-denial paths were added, and **nothing was
 * listening** — five call sites across the call and battery systems pushed
 * notifications into the void, so a player denied permission saw no feedback at all.
 */
onNet(
  'mica:client:shell:notify',
  (payload: { type?: string; title?: string; message?: string }) => {
    const message = typeof payload?.message === 'string' ? payload.message : '';
    if (!message) return;

    sendNuiMessage('notify', {
      type: payload?.type ?? 'info',
      title: payload?.title,
      message
    });
  }
);

/**
 * A freshly loaded character's phone should stop showing the previous one's data.
 *
 * `server/lib/shell.ts`'s `pushRehydrate` is the one place both frameworks'
 * character-loaded event feeds into this. The push carries nothing — the phone re-reads
 * everything over the ordinary bootstrap round trip, which already scopes each read to the
 * caller's citizenid.
 */
onNet('mica:client:shell:rehydrate', () => {
  sendNuiMessage('rehydrateShell', {});
});

/**
 * The `SetPhoneEnabled` export. A job confiscating the phone, or an item that jams it.
 *
 * Disabling while open force-closes it the same way `hideFrame` does — leaving it open
 * would mean the ban applies to the *next* press of `M` rather than to right now.
 *
 * A bare boolean is the phone, as it always was; `{ device, enabled }` names another.
 */
onNet('mica:client:shell:setEnabled', (payload: unknown) => {
  const value =
    typeof payload === 'boolean' ? payload : (payload as { enabled?: unknown })?.enabled === true;
  const device = deviceOf(payload);
  DeviceState.setEnabled(device, value);
  closeIfDisabled(device);
});

/**
 * Whether this server has a device on at all — the descriptor's enable convar, pushed by
 * the server (MICA-263). The phone has no such convar and never receives this.
 */
onNet('mica:client:shell:setServerEnabled', (payload: unknown) => {
  const device = deviceOf(payload);
  DeviceState.setServerEnabled(device, (payload as { enabled?: unknown })?.enabled === true);
  closeIfDisabled(device);
});

/**
 * The item gate (MICA-229). The server counts and pushes; this only remembers, and closes
 * the device when its last item has just gone -- the same force-close `setEnabled` does,
 * for the same reason. Absent `device` is the phone (MICA-262).
 */
onNet(
  'mica:client:shell:phoneItem',
  (payload: { device?: unknown; gated?: unknown; held?: unknown }) => {
    const device = deviceOf(payload);
    DeviceState.setItemGate(device, payload?.gated === true, payload?.held === true);
    closeIfDisabled(device);
  }
);

/** Using a device's item opens it. Refused while disabled, like `openApp` below. */
onNet('mica:client:shell:open', (payload?: unknown) => {
  const device = deviceOf(payload);
  if (!DeviceState.isEnabled(device) || DeviceState.isOpen(device)) return;
  openDevice(device);
});

/**
 * The `OpenApp` export. Force-opens a device and lands on the named app, the same
 * `appId?key=value` shape a notification's deep link already carries. The device is the
 * one named, else the phone; raising it lowers the other (MICA-262).
 *
 * Silently refused while that device is disabled — there is no reply channel for this
 * event to report through, matching `guardNetEvent`'s own reasoning on the server side.
 */
onNet(
  'mica:client:shell:openApp',
  (payload: { appId?: string; props?: Record<string, unknown>; device?: unknown }) => {
    const device = deviceOf(payload);
    if (!DeviceState.isEnabled(device)) return;
    const appId = payload?.appId;
    if (!appId) return;

    if (!DeviceState.isOpen(device)) {
      openDevice(device);
    }
    sendNuiMessage('openApp', { appId, props: payload?.props ?? {}, device });
  }
);
