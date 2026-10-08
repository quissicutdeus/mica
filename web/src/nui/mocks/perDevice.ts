// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALL_DEVICES, DEFAULT_DEVICE, type DeviceId } from '@mica/shared/devices';
import type { MockContext, MockHandler } from './registry';

/**
 * Mock state kept once per device (MICA-264), for the services the server keeps per device:
 * notes, settings and the lock screen's passcode. A phone and a tablet are two identities
 * there, so in a browser they have to be two as well, or no spec could show a note written on
 * one missing from the other — and a request stamped with the wrong device would pass.
 *
 * Each handler picks its device's state off the `MockContext` the registry hands it, which
 * reads the envelope's `device` as the server does. Mail, Admin and the Store stay per
 * citizen, and their mocks keep a single table.
 */
export type PerDevice<T> = Record<DeviceId, T>;

export const perDeviceState = <T>(initial: (device: DeviceId) => T): PerDevice<T> =>
  Object.fromEntries(ALL_DEVICES.map((device) => [device, initial(device)])) as PerDevice<T>;

/** The device a request speaks for: the phone when nothing says otherwise. */
export const deviceOf = (context?: MockContext): DeviceId => context?.device ?? DEFAULT_DEVICE;

/**
 * One handler table per device, built from that device's own state, behind one set of keys
 * that dispatches by the request's device. For a block built by a factory —
 * `defineMockCrud(rows, …)` — that cannot take a device itself.
 */
export function perDeviceHandlers<S>(
  state: PerDevice<S>,
  build: (state: S) => Record<string, MockHandler>
): Record<string, MockHandler> {
  const tables = perDeviceState((device) => build(state[device]));
  return Object.fromEntries(
    Object.keys(tables[DEFAULT_DEVICE]).map((key): [string, MockHandler] => [
      key,
      (data, context): unknown => tables[deviceOf(context)][key](data, context)
    ])
  );
}
