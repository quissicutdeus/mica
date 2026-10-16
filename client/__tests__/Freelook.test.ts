// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The held-control flush on a device close (MICA-370): it runs only when keep-input was on
 * during that open, since only keep-input can strand a held control. A plain open and close
 * no longer swallows ~160ms of the player's input.
 *
 * Manual native stubs, capturing each `setTick` so frames can be driven by hand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FreelookClass = typeof import('../game/Freelook').Freelook;

const g = globalThis as Record<string, unknown>;

let ticks: Map<number, () => void>;
let nextTick: number;
let disableAll: number;
let focus: unknown[][];
let keepInput: boolean[];

const frame = () => {
  for (const cb of ticks.values()) cb();
};

const load = async (): Promise<FreelookClass> => {
  vi.resetModules();
  return (await import('../game/Freelook')).Freelook;
};

beforeEach(() => {
  ticks = new Map();
  nextTick = 0;
  disableAll = 0;
  focus = [];
  keepInput = [];
  Object.assign(g, {
    setTick: (cb: () => void) => {
      ticks.set(++nextTick, cb);
      return nextTick;
    },
    clearTick: (id: number) => {
      ticks.delete(id);
    },
    DisableAllControlActions: () => {
      disableAll += 1;
    },
    EnableControlAction: () => {},
    SetNuiFocus: (...args: unknown[]) => focus.push(args),
    SetNuiFocusKeepInput: (on: boolean) => keepInput.push(on)
  });
});

describe('Freelook — flush on close', () => {
  it('does not flush on a close when keep-input was never on', async () => {
    const freelook = await load();

    freelook.resetFreelook();

    expect(ticks.size).toBe(0);
    for (let i = 0; i < 20; i += 1) frame();
    expect(disableAll).toBe(0);
    // Focus is still released either way.
    expect(focus).toEqual([[false, false]]);
    expect(keepInput).toEqual([false]);
  });

  it('flushes for ten frames on a close while freelook holds keep-input', async () => {
    const freelook = await load();
    freelook.enableFreelook();
    frame();
    const beforeClose = disableAll;

    freelook.resetFreelook();
    for (let i = 0; i < 20; i += 1) frame();

    expect(disableAll - beforeClose).toBe(10);
    expect(ticks.size).toBe(0);
  });

  it('flushes on a close after freelook was on and then off during the same open', async () => {
    const freelook = await load();
    freelook.enableFreelook('camera');
    freelook.disableFreelook();
    for (let i = 0; i < 20; i += 1) frame();
    const afterDisable = disableAll;
    expect(afterDisable).toBe(10);

    freelook.resetFreelook();
    for (let i = 0; i < 20; i += 1) frame();

    expect(disableAll - afterDisable).toBe(10);
  });

  it('forgets keep-input at the close, so the next plain close does not flush', async () => {
    const freelook = await load();
    freelook.enableFreelook();
    freelook.resetFreelook();
    for (let i = 0; i < 20; i += 1) frame();
    const settled = disableAll;

    freelook.resetFreelook();
    for (let i = 0; i < 20; i += 1) frame();

    expect(disableAll).toBe(settled);
    expect(ticks.size).toBe(0);
  });
});
