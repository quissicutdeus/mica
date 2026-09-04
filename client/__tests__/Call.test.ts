// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `Call.ts` is the whole client-side voice integration: three `exports['pma-voice']`
 * calls and the NUI focus/visibility push on an incoming call. Nothing asserted any of
 * it before this file — see MICA-55.
 *
 * Same manual-stub pattern `ServiceProxy.test.ts` uses rather than the shared FiveM
 * stubs in `server/__tests__/setup.ts`: those are `noop`s, and this file needs to
 * capture the callbacks/handlers `Call.ts` registers at import time to drive them.
 */

let nuiCallbacks: Map<string, (data: any, cb: Function) => void>;
let netSubscriptions: Map<string, (data: any) => void>;
let triggeredServerEvents: unknown[][];
let sentNuiMessages: unknown[];
let nuiFocusCalls: unknown[][];
let registeredNuiTypes: string[];
let pmaVoice: {
  setPlayerTalkingOverride: ReturnType<typeof vi.fn>;
  addPlayerToCall: ReturnType<typeof vi.fn>;
  removePlayerFromCall: ReturnType<typeof vi.fn>;
};

// The incoming-call path raises the phone through `DeviceVisibility` (MICA-262), the
// same sequence the key uses; that sequence has its own suite, so here it is a spy.
const { openDeviceSpy, phoneOpen } = vi.hoisted(() => ({
  openDeviceSpy: vi.fn(),
  phoneOpen: { value: false }
}));
vi.mock('../lib/DeviceVisibility', () => ({ openDevice: openDeviceSpy }));
vi.mock('../lib/DeviceState', () => ({
  DeviceState: { isOpen: (id: string) => id === 'phone' && phoneOpen.value }
}));

beforeEach(async () => {
  vi.resetModules();
  openDeviceSpy.mockClear();
  phoneOpen.value = false;

  nuiCallbacks = new Map();
  netSubscriptions = new Map();
  triggeredServerEvents = [];
  sentNuiMessages = [];
  nuiFocusCalls = [];
  registeredNuiTypes = [];
  pmaVoice = {
    setPlayerTalkingOverride: vi.fn(),
    addPlayerToCall: vi.fn(),
    removePlayerFromCall: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.RegisterNuiCallbackType = (name: string) => registeredNuiTypes.push(name);
  g.on = (event: string, handler: any) => {
    nuiCallbacks.set(event.replace('__cfx_nui:', ''), handler);
  };
  g.onNet = (event: string, handler: any) => netSubscriptions.set(event, handler);
  g.TriggerServerEvent = (...args: unknown[]) => triggeredServerEvents.push(args);
  g.SendNuiMessage = (payload: unknown) => sentNuiMessages.push(JSON.parse(payload as string));
  g.SetNuiFocus = (...args: unknown[]) => nuiFocusCalls.push(args);

  const exportsFn = ((name: string) => (exportsFn as any)[name]) as ((name: string) => unknown) & {
    'pma-voice'?: typeof pmaVoice;
  };
  exportsFn['pma-voice'] = pmaVoice;
  g.exports = exportsFn;

  await import('../services/Call');
});

const nuiCall = (name: string, data: unknown = {}): Promise<unknown> =>
  new Promise((resolve) => {
    nuiCallbacks.get(name)!(data, resolve);
  });

const serverEvent = (event: string, data?: unknown) => netSubscriptions.get(event)!(data);

describe('NUI callbacks', () => {
  it('registers every callback the phone UI can invoke', () => {
    expect(registeredNuiTypes.toSorted()).toEqual(
      [
        'answerCall',
        'endCall',
        'rejectCall',
        'simulateIncomingCall',
        'startCall',
        'toggleMute',
        'toggleSpeaker'
      ].toSorted()
    );
  });

  it('startCall relays the number and answers dialing', async () => {
    const result = await nuiCall('startCall', { number: '555-0199' });

    expect(triggeredServerEvents).toEqual([['mica:server:phone:start', '555-0199']]);
    expect(result).toEqual({ status: 'dialing' });
  });

  it('answerCall relays with no payload and answers connected', async () => {
    const result = await nuiCall('answerCall');

    expect(triggeredServerEvents).toEqual([['mica:server:phone:answer']]);
    expect(result).toEqual({ status: 'connected' });
  });

  it('endCall relays end and answers idle', async () => {
    const result = await nuiCall('endCall');

    expect(triggeredServerEvents).toEqual([['mica:server:phone:end']]);
    expect(result).toEqual({ status: 'idle' });
  });

  it('rejectCall is the same server action as hanging up', async () => {
    const result = await nuiCall('rejectCall');

    expect(triggeredServerEvents).toEqual([['mica:server:phone:end']]);
    expect(result).toEqual({ status: 'idle' });
  });

  it('simulateIncomingCall relays the number and always answers success', async () => {
    const result = await nuiCall('simulateIncomingCall', { number: '555-0177' });

    expect(triggeredServerEvents).toEqual([['mica:server:phone:simulateIncoming', '555-0177']]);
    expect(result).toEqual({ success: true });
  });

  it('toggleMute asks pma-voice to override talking state, inverted', async () => {
    const result = await nuiCall('toggleMute', { muted: true });

    expect(pmaVoice.setPlayerTalkingOverride).toHaveBeenCalledWith(false);
    expect(result).toEqual({ muted: true });
  });

  it('toggleMute stays consistent when pma-voice is absent', async () => {
    (globalThis as any).exports['pma-voice'] = undefined;

    const result = await nuiCall('toggleMute', { muted: false });

    expect(result).toEqual({ muted: false });
  });

  it('toggleSpeaker is UI state only and always reports success', async () => {
    const result = await nuiCall('toggleSpeaker', { enabled: true });

    expect(result).toEqual({ success: true });
  });
});

describe('incoming call', () => {
  it('raises the phone through the shared open sequence, then pushes the incoming status', () => {
    serverEvent('mica:client:phone:incoming', { from: '555-0199', callId: 42 });

    expect(openDeviceSpy).toHaveBeenCalledWith('phone');
    expect(sentNuiMessages).toEqual([
      {
        action: 'callStatus',
        data: { status: 'incoming', number: '555-0199', name: 'Unknown' }
      }
    ]);
  });

  it('leaves a phone that is already up alone', () => {
    phoneOpen.value = true;
    serverEvent('mica:client:phone:incoming', { from: '555-0199', callId: 42 });

    expect(openDeviceSpy).not.toHaveBeenCalled();
    expect(sentNuiMessages[0]).toEqual({
      action: 'callStatus',
      data: { status: 'incoming', number: '555-0199', name: 'Unknown' }
    });
  });
});

describe('accepted', () => {
  it('joins the pma-voice channel with the call id and shows connected', () => {
    serverEvent('mica:client:phone:accepted', { callId: 42 });

    expect(pmaVoice.addPlayerToCall).toHaveBeenCalledWith(42);
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'connected' } }]);
  });

  it('still shows connected when pma-voice is absent, rather than throwing', () => {
    (globalThis as any).exports['pma-voice'] = undefined;

    expect(() => serverEvent('mica:client:phone:accepted', { callId: 42 })).not.toThrow();
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'connected' } }]);
  });
});

describe('ended', () => {
  it('leaves the pma-voice channel and returns to idle — every teardown path funnels here', () => {
    serverEvent('mica:client:phone:ended');

    expect(pmaVoice.removePlayerFromCall).toHaveBeenCalledTimes(1);
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'idle' } }]);
  });

  it('still returns to idle when pma-voice is absent, rather than stranding the UI', () => {
    (globalThis as any).exports['pma-voice'] = undefined;

    expect(() => serverEvent('mica:client:phone:ended')).not.toThrow();
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'idle' } }]);
  });
});

describe('failed', () => {
  it('returns to idle without touching pma-voice — no channel was ever joined at this point', () => {
    serverEvent('mica:client:phone:failed');

    expect(pmaVoice.addPlayerToCall).not.toHaveBeenCalled();
    expect(pmaVoice.removePlayerFromCall).not.toHaveBeenCalled();
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'idle' } }]);
  });
});
