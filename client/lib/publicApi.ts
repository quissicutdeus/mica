// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client-side export surface (MICA-224).
 *
 * Inventory, target, progress-bar and vehicle scripts run on the client and want to ask the
 * phone whether it is open, close it while a minigame runs, or raise a toast, without a
 * server round trip. Every name here answers the same discriminated outcome the server's
 * exports do (`@mica/shared/exports`) and never throws into the caller's resource.
 *
 * **Nothing here is authority.** Every one of these acts on this client's own `DeviceState`
 * and NUI, which a modified client already controls outright, so the server trusts none of
 * it: `IsPhoneOpen` on the server is a mirror of what the client last said, and
 * `SetPhoneEnabled` from either side sets the same client-local flag the server's own push
 * sets. Where the same concept exists on both sides the name is the same, so a script
 * reading the README's one table knows what to call from where.
 *
 * Registered from `client.ts` after the services, the way `server/lib/publicApi.ts` is from
 * `server.ts`, so every handler the exports reach for exists before anything can call one.
 */
import { DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';
import { ok, fail, type ExportOutcome } from '@mica/shared/exports';
import { DeviceState } from './DeviceState';
import { openDevice, closeDevice, setDeviceEnabled, toggleDevice } from './DeviceVisibility';
import { sendNuiMessage } from './nui';
import { FrameworkBridge } from './FrameworkBridge';

/** Bumped when an existing export changes shape, not when one is added -- the server's rule. */
export const MICA_CLIENT_API_VERSION = 1;

const APP_ID = /^[a-z][a-z0-9_]*$/;

const registered = new Map<string, Function>();

const publish = (name: string, fn: Function): void => {
  registered.set(name, fn);
  if (typeof exports === 'function') {
    (exports as unknown as (name: string, fn: Function) => void)(name, fn);
  }
};

export const publishedClientExports = (): string[] => [...registered.keys()].sort();

export const publishedClientExport = (name: string): Function | undefined => registered.get(name);

const guarded =
  <A extends unknown[], T>(name: string, handler: (...args: A) => ExportOutcome<T>) =>
  (...args: A): ExportOutcome<T> => {
    try {
      return handler(...args);
    } catch (error) {
      console.error(`[mica] client export '${name}' threw:`, error);
      return fail<T>('internal_error', 'micaOS failed to handle that request.');
    }
  };

/**
 * An optional trailing device argument. Absent means the phone; anything that is not a
 * device id is refused rather than defaulted, because a typo silently acting on the phone
 * when the tablet was meant is the kind of bug that survives a test run.
 */
const deviceFrom = (raw: unknown): DeviceId | null => {
  if (raw === undefined || raw === null) return DEFAULT_DEVICE;
  return isDeviceId(raw) ? raw : null;
};

const badDevice = <T>(raw: unknown): ExportOutcome<T> =>
  fail<T>('invalid_args', `'${String(raw)}' is not a device; use 'phone' or 'tablet', or omit it.`);

export const registerClientApi = (): void => {
  publish(
    'GetApiVersion',
    guarded('GetApiVersion', () => ok(MICA_CLIENT_API_VERSION))
  );

  /** Whether this player's device is open. The server's `IsPhoneOpen(source)` mirrors this. */
  publish(
    'IsPhoneOpen',
    guarded('IsPhoneOpen', (rawDevice?: unknown) => {
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<boolean>(rawDevice);
      return ok(DeviceState.isOpen(device));
    })
  );

  /**
   * Open the device, as the keybind would. Refused while it is disabled -- confiscated,
   * switched off by the server, or an item the player does not hold -- with `disabled`.
   */
  publish(
    'OpenPhone',
    guarded('OpenPhone', (rawDevice?: unknown) => {
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<undefined>(rawDevice);
      if (!DeviceState.isEnabled(device)) {
        return fail('disabled', 'The device is disabled for this player right now.');
      }
      if (!DeviceState.isOpen(device)) openDevice(device);
      return ok();
    })
  );

  /** Close the device. Always allowed: a minigame or a cutscene wants it down regardless. */
  publish(
    'ClosePhone',
    guarded('ClosePhone', (rawDevice?: unknown) => {
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<undefined>(rawDevice);
      if (DeviceState.isOpen(device)) closeDevice(device);
      return ok();
    })
  );

  /**
   * What the key does, including its refusals: nothing while a text field has focus, and a
   * disabled device asks the server to look at the inventory again rather than opening.
   * Answers the state afterwards, so a caller does not have to ask twice.
   */
  publish(
    'TogglePhone',
    guarded('TogglePhone', (rawDevice?: unknown) => {
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<{ open: boolean }>(rawDevice);
      toggleDevice(device);
      return ok({ open: DeviceState.isOpen(device) });
    })
  );

  /**
   * Confiscate or return the device from a client script -- the same flag the server's
   * `SetPhoneEnabled(source, enabled)` sets through its push, so the two agree whichever side
   * spoke last. Disabling while open force-closes it. Client-local and not persisted, the
   * same as the server's: reapply it on your own player-loaded event if it must survive one.
   */
  publish(
    'SetPhoneEnabled',
    guarded('SetPhoneEnabled', (enabled: unknown, rawDevice?: unknown) => {
      if (typeof enabled !== 'boolean') {
        return fail('invalid_args', 'A boolean is required.');
      }
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<undefined>(rawDevice);
      setDeviceEnabled(device, enabled);
      return ok();
    })
  );

  /**
   * This player's phone number as the framework reports it. `not_ready` until a character
   * is loaded. The server's `GetPhoneNumber(citizenid)` is the one that works for anybody,
   * online or off; this is the one that costs no round trip.
   */
  publish(
    'GetPhoneNumber',
    guarded('GetPhoneNumber', () => {
      const number = FrameworkBridge.getPhoneNumber();
      if (!number) return fail<string>('not_ready', 'No character with a phone number is loaded.');
      return ok(number);
    })
  );

  /**
   * Force-open the device on a named app, the server's `OpenApp(source, appId, props)`
   * without the hop. The client has no list of installed apps to check against -- only the
   * server does -- so the id is checked for shape here and an unknown one is the shell's to
   * ignore. Refused while the device is disabled, the same as the server's push is.
   */
  publish(
    'OpenApp',
    guarded('OpenApp', (appId: unknown, props?: unknown, rawDevice?: unknown) => {
      const id = String(appId ?? '').toLowerCase();
      if (!APP_ID.test(id))
        return fail('invalid_args', `'${String(appId)}' is not a valid app id.`);
      const device = deviceFrom(rawDevice);
      if (!device) return badDevice<undefined>(rawDevice);
      if (!DeviceState.isEnabled(device)) {
        return fail('disabled', 'The device is disabled for this player right now.');
      }
      if (!DeviceState.isOpen(device)) openDevice(device);
      sendNuiMessage('openApp', {
        appId: id,
        props: props && typeof props === 'object' ? props : {},
        device
      });
      return ok();
    })
  );

  /**
   * A toast on this client, and nothing else: no row, no badge, nothing the player finds in
   * the shade later. That is the difference from the server's `SendNotification`, which
   * writes one; a progress bar's "done" belongs here, a job offer belongs there.
   */
  publish(
    'Notify',
    guarded('Notify', (options: unknown) => {
      if (!options || typeof options !== 'object') {
        return fail('invalid_args', 'A notification object is required.');
      }
      const opts = options as { type?: unknown; title?: unknown; message?: unknown };
      const message = typeof opts.message === 'string' ? opts.message.trim() : '';
      if (!message) return fail('invalid_args', 'A message is required.');
      sendNuiMessage('notify', {
        type: typeof opts.type === 'string' ? opts.type : 'info',
        title: typeof opts.title === 'string' ? opts.title : undefined,
        message
      });
      return ok();
    })
  );
};
