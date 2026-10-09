// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sorted } from './arrays';

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
  setCallChannel: ReturnType<typeof vi.fn>;
  SetCallChannel: ReturnType<typeof vi.fn>;
  removePlayerFromCall: ReturnType<typeof vi.fn>;
  getCallVolume: ReturnType<typeof vi.fn>;
  setCallVolume: ReturnType<typeof vi.fn>;
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
    setCallChannel: vi.fn(),
    SetCallChannel: vi.fn(),
    removePlayerFromCall: vi.fn(),
    getCallVolume: vi.fn(() => 60),
    setCallVolume: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.RegisterNuiCallbackType = (name: string) => registeredNuiTypes.push(name);
  g.on = (event: string, handler: any) => {
    nuiCallbacks.set(event.replace('__cfx_nui:', ''), handler);
  };
  g.GetCurrentResourceName = () => 'mica';
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
    expect(sorted(registeredNuiTypes)).toEqual(
      sorted([
        'answerCall',
        'endCall',
        'rejectCall',
        'simulateIncomingCall',
        'startCall',
        'toggleMute'
      ])
    );
  });

  it('registers no speaker callback -- the speaker is the contracted phone:speaker (MICA-246)', () => {
    expect(registeredNuiTypes).not.toContain('toggleSpeaker');
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
});

describe('the server withdrawing the speaker mid-call (MICA-246)', () => {
  const withdraw = () => serverEvent('mica:client:phone:speakerState', { available: false });

  it('re-sends connected with the speaker withdrawn', () => {
    serverEvent('mica:client:phone:accepted', { callId: 4, speaker: true });
    sentNuiMessages.length = 0;
    withdraw();

    expect(sentNuiMessages).toEqual([
      { action: 'callStatus', data: { status: 'connected', speakerAvailable: false } }
    ]);
  });

  it('never turns an idle phone into a call screen', () => {
    withdraw();
    serverEvent('mica:client:phone:accepted', { callId: 4, speaker: true });
    serverEvent('mica:client:phone:ended');
    sentNuiMessages.length = 0;
    withdraw();

    expect(sentNuiMessages).toEqual([]);
  });
});

describe('listening to a nearby speaker (MICA-246)', () => {
  const listen = (data: unknown) => serverEvent('mica:client:phone:speakerListen', data);

  it('lowers the call volume while listening and puts it back after', () => {
    listen({ listening: true, volume: 30 });
    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(30);

    listen({ listening: false });
    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it('saves the volume once, so a second push does not save the lowered one', () => {
    listen({ listening: true, volume: 30 });
    pmaVoice.getCallVolume.mockReturnValue(30);
    listen({ listening: true, volume: 20 });
    listen({ listening: false });

    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it('restores exactly once', () => {
    listen({ listening: true, volume: 30 });
    listen({ listening: false });
    listen({ listening: false });

    expect(pmaVoice.setCallVolume).toHaveBeenCalledTimes(2);
  });

  it('leaves the volume alone when it cannot read what to put back', () => {
    pmaVoice.getCallVolume.mockReturnValue(undefined as unknown as number);
    listen({ listening: true, volume: 30 });

    expect(pmaVoice.setCallVolume).not.toHaveBeenCalled();
  });

  it('ignores a volume that is not a number', () => {
    listen({ listening: true, volume: 'loud' });
    expect(pmaVoice.setCallVolume).not.toHaveBeenCalled();
  });

  it("puts the volume back when this player's own call connects", () => {
    listen({ listening: true, volume: 30 });
    serverEvent('mica:client:phone:accepted', { callId: 9, speaker: true });

    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it('puts the volume back when this resource stops, and only for this resource', () => {
    listen({ listening: true, volume: 30 });
    nuiCallbacks.get('onResourceStop')!('some-other-resource', () => {});
    expect(pmaVoice.setCallVolume).toHaveBeenCalledTimes(1);

    nuiCallbacks.get('onResourceStop')!('mica', () => {});
    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it("puts the volume back when this player's own refused dial ends -- it left the channel", () => {
    listen({ listening: true, volume: 30 });
    serverEvent('mica:client:phone:ended');

    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it('puts the volume back when this player hangs up their own dial', async () => {
    listen({ listening: true, volume: 30 });
    await nuiCall('endCall');

    expect(pmaVoice.setCallVolume).toHaveBeenLastCalledWith(60);
  });

  it('does not throw without pma-voice', () => {
    (globalThis as any).exports['pma-voice'] = undefined;
    expect(() => listen({ listening: true, volume: 30 })).not.toThrow();
    expect(() => listen({ listening: false })).not.toThrow();
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

/**
 * Every way pma-voice's client lets a script pick a call channel. Each one ends in its
 * `pma-voice:setPlayerCall` net event, which pma-voice's server takes from any client for any
 * channel, so the server places and removes the parties itself (MICA-341).
 */
const clientChannelCalls = () => [
  ...pmaVoice.addPlayerToCall.mock.calls,
  ...pmaVoice.setCallChannel.mock.calls,
  ...pmaVoice.SetCallChannel.mock.calls,
  ...pmaVoice.removePlayerFromCall.mock.calls,
  ...triggeredServerEvents.filter(([event]) => String(event).startsWith('pma-voice:'))
];

describe('accepted', () => {
  it('shows connected and does not join the channel itself -- the server has (MICA-341)', () => {
    serverEvent('mica:client:phone:incoming', { from: '555-0101', callId: 42 });
    serverEvent('mica:client:phone:accepted', { callId: 42, speaker: true });

    expect(clientChannelCalls()).toEqual([]);
    expect(sentNuiMessages[sentNuiMessages.length - 1]).toEqual({
      action: 'callStatus',
      data: { status: 'connected', speakerAvailable: true }
    });
  });

  it('hides the speaker unless the server offered it, whatever else it said (MICA-246)', () => {
    serverEvent('mica:client:phone:accepted', { callId: 42 });
    serverEvent('mica:client:phone:accepted', { callId: 42, speaker: 'yes' });

    expect(sentNuiMessages).toEqual([
      { action: 'callStatus', data: { status: 'connected', speakerAvailable: false } },
      { action: 'callStatus', data: { status: 'connected', speakerAvailable: false } }
    ]);
  });

  it('still shows connected when pma-voice is absent, rather than throwing', () => {
    (globalThis as any).exports['pma-voice'] = undefined;

    expect(() => serverEvent('mica:client:phone:accepted', { callId: 42 })).not.toThrow();
    expect(sentNuiMessages).toEqual([
      { action: 'callStatus', data: { status: 'connected', speakerAvailable: false } }
    ]);
  });
});

describe('ended', () => {
  it('returns to idle and leaves the channel to the server -- every teardown funnels here', () => {
    serverEvent('mica:client:phone:accepted', { callId: 42 });
    serverEvent('mica:client:phone:ended');

    expect(clientChannelCalls()).toEqual([]);
    expect(sentNuiMessages[sentNuiMessages.length - 1]).toEqual({
      action: 'callStatus',
      data: { status: 'idle' }
    });
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

    expect(clientChannelCalls()).toEqual([]);
    expect(sentNuiMessages).toEqual([{ action: 'callStatus', data: { status: 'idle' } }]);
  });
});

describe('isInCall (MICA-232)', () => {
  const inCall = async () => (await import('../services/Call')).isInCall();

  it('is true only from accepted until ended -- ringing is not a call', async () => {
    expect(await inCall()).toBe(false);
    serverEvent('mica:client:phone:incoming', { from: '555-0101', callId: 4 });
    expect(await inCall()).toBe(false);
    serverEvent('mica:client:phone:accepted', { callId: 4 });
    expect(await inCall()).toBe(true);
    serverEvent('mica:client:phone:ended');
    expect(await inCall()).toBe(false);
  });

  it('is cleared by hanging up locally -- the server never sends ended to the side that ended', async () => {
    serverEvent('mica:client:phone:accepted', { callId: 4 });
    await nuiCall('endCall');
    expect(await inCall()).toBe(false);
  });

  it('hanging up locally asks the server, which takes the player out of the channel', async () => {
    serverEvent('mica:client:phone:accepted', { callId: 4 });
    expect(await nuiCall('endCall')).toEqual({ status: 'idle' });
    expect(triggeredServerEvents).toEqual([['mica:server:phone:end']]);
    expect(clientChannelCalls()).toEqual([]);
  });

  it('rejecting a ringing call does not touch pma-voice -- it was never joined', async () => {
    serverEvent('mica:client:phone:incoming', { from: '555-0101', callId: 4 });
    await nuiCall('rejectCall');
    expect(clientChannelCalls()).toEqual([]);
  });

  it('is cleared by failed', async () => {
    serverEvent('mica:client:phone:accepted', { callId: 4 });
    serverEvent('mica:client:phone:failed');
    expect(await inCall()).toBe(false);
  });

  it('ignores the page: answerCall alone does not put the player in a call', async () => {
    await nuiCall('answerCall');
    expect(await inCall()).toBe(false);
  });
});
