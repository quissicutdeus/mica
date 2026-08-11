import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bridgeMock, netHandlers, dropHandlers } = vi.hoisted(() => {
  const net: Record<string, Function> = {};
  const drop: Function[] = [];
  (globalThis as any).onNet = (event: string, handler: Function) => {
    net[event] = handler;
  };
  (globalThis as any).on = (event: string, handler: Function) => {
    if (event === 'playerDropped') drop.push(handler);
  };
  return {
    bridgeMock: { getPlayer: vi.fn() },
    netHandlers: net,
    dropHandlers: drop
  };
});
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import { isPhoneOpen } from '../lib/PhoneOpenState';

const SRC = 11;

/**
 * There is no synchronous way to ask a client whether the phone is open — see the
 * module's own doc comment — so this is fed by a fire-and-forget push and answers from
 * whatever it last heard. These assertions drive that push directly.
 */
describe('PhoneOpenState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).source = SRC;
    bridgeMock.getPlayer.mockReturnValue({ citizenid: 'ABC12345' });
  });

  it('defaults to closed for a source never heard from', () => {
    expect(isPhoneOpen(999)).toBe(false);
  });

  it('remembers what the client last pushed', () => {
    netHandlers['gphone:server:shell:setOpen'](true);
    expect(isPhoneOpen(SRC)).toBe(true);

    netHandlers['gphone:server:shell:setOpen'](false);
    expect(isPhoneOpen(SRC)).toBe(false);
  });

  it('ignores a push from a source with no loaded character', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    netHandlers['gphone:server:shell:setOpen'](true);
    expect(isPhoneOpen(SRC)).toBe(false);
  });

  it('forgets a source when it drops, so the next player does not inherit it', () => {
    netHandlers['gphone:server:shell:setOpen'](true);
    expect(isPhoneOpen(SRC)).toBe(true);

    for (const handler of dropHandlers) handler();
    expect(isPhoneOpen(SRC)).toBe(false);
  });
});
