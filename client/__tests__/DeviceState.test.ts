// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The client's per-device table (MICA-262). Same manual-stub pattern `Call.test.ts`
 * uses: the one FiveM global the module touches is captured so the push can be asserted.
 */
let triggered: unknown[][];
(globalThis as Record<string, unknown>).TriggerServerEvent = (...args: unknown[]) => {
  triggered.push(args);
};

import { DeviceState } from '../lib/DeviceState';

describe('DeviceState', () => {
  beforeEach(() => {
    triggered = [];
    DeviceState.__reset();
  });

  it('starts with nothing open and the phone the only device the server has on', () => {
    expect(DeviceState.openDevice()).toBeNull();
    expect(DeviceState.isAnyOpen()).toBe(false);
    // Decision 5 of MICA-252: the tablet is off until the server says otherwise.
    expect(DeviceState.isEnabled('phone')).toBe(true);
    expect(DeviceState.isEnabled('tablet')).toBe(false);
  });

  it('pushes every open change to the server with the device named', () => {
    DeviceState.setOpen('tablet', true);
    expect(DeviceState.isOpen('tablet')).toBe(true);
    expect(DeviceState.openDevice()).toBe('tablet');
    expect(triggered).toEqual([['mica:server:shell:setOpen', { device: 'tablet', open: true }]]);

    DeviceState.setOpen('tablet', false);
    expect(DeviceState.isAnyOpen()).toBe(false);
    expect(triggered[1]).toEqual(['mica:server:shell:setOpen', { device: 'tablet', open: false }]);
  });

  it('keeps the three gates independent, any one of which keeps a device shut', () => {
    DeviceState.setServerEnabled('tablet', true);
    expect(DeviceState.isEnabled('tablet')).toBe(true);

    DeviceState.setEnabled('tablet', false);
    expect(DeviceState.isEnabled('tablet')).toBe(false);
    DeviceState.setEnabled('tablet', true);

    DeviceState.setItemGate('tablet', true, false);
    expect(DeviceState.isEnabled('tablet')).toBe(false);
    expect(DeviceState.isItemGated('tablet')).toBe(true);
    expect(DeviceState.isAnyItemGated()).toBe(true);

    // Ungated means held, whatever the server said about holding.
    DeviceState.setItemGate('tablet', false, false);
    expect(DeviceState.isEnabled('tablet')).toBe(true);
    expect(DeviceState.isAnyItemGated()).toBe(false);

    // And none of that touched the phone.
    expect(DeviceState.isEnabled('phone')).toBe(true);
  });

  it('shares one typing flag, since there is one NUI document', () => {
    DeviceState.setTyping(true);
    expect(DeviceState.isTyping()).toBe(true);
    DeviceState.setTyping(false);
    expect(DeviceState.isTyping()).toBe(false);
  });
});
