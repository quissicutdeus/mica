// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE } from './devices';
import { parseDeviceArg, parseGenericRequest } from './rpc';

/**
 * The device half of a request (MICA-264). A phone and a tablet are two identities, so the
 * device a request names decides whose rows it reads. These pin the two ways that can go
 * wrong at the parse: a bad value silently becoming the other device, and an old client that
 * sends no device being locked out.
 */
describe('the device a generic request names', () => {
  it('carries a device that is one of ours', () => {
    expect(parseGenericRequest({ service: 'notes', action: 'get', device: 'tablet' })).toEqual({
      service: 'notes',
      action: 'get',
      data: undefined,
      device: 'tablet'
    });
  });

  it('leaves the device off a request that sent none, so it still means the phone', () => {
    const parsed = parseGenericRequest({ service: 'notes', action: 'get', data: {} });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('device');
  });

  it('refuses the whole request when the device is present but not a device', () => {
    for (const device of ['laptop', 'PHONE', '', null, 1, {}, ['tablet']]) {
      expect(parseGenericRequest({ service: 'notes', action: 'get', device })).toBeNull();
    }
  });
});

describe('the device argument of a server event', () => {
  it('reads a missing argument as the default device, for a client from before the tablet', () => {
    expect(parseDeviceArg(undefined)).toBe(DEFAULT_DEVICE);
    expect(DEFAULT_DEVICE).toBe('phone');
  });

  it('passes each device through', () => {
    expect(parseDeviceArg('phone')).toBe('phone');
    expect(parseDeviceArg('tablet')).toBe('tablet');
  });

  it('answers null for anything else, which the server refuses', () => {
    for (const raw of ['laptop', 'Tablet', '', null, 0, {}, ['phone']]) {
      expect(parseDeviceArg(raw)).toBeNull();
    }
  });
});
