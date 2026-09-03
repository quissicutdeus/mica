// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEVICES } from './devices';
import {
  conflictsWith,
  findAction,
  GAME_SCOPE_ACTIONS,
  PHONE_SCOPE_ACTIONS,
  type KeybindAction
} from './keybinds';

describe('conflictsWith', () => {
  it('finds a conflict against the default core action list when no candidates are given', () => {
    const back = findAction('back')!;
    // 'closePhone' defaults to Escape, 'back' to Backspace — rebind back onto Escape.
    const conflict = conflictsWith(back, 'Escape', {});
    expect(conflict?.id).toBe('closePhone');
  });

  it('finds no conflict against the core list for a key nothing core uses', () => {
    const back = findAction('back')!;
    expect(conflictsWith(back, 'k', {})).toBeUndefined();
  });

  it('checks against an explicit candidate list instead of the core default', () => {
    // Two app-declared actions sharing the same `when` — a real collision, since both
    // are eligible together whenever that app is foreground.
    const pause: KeybindAction = {
      id: 'snek:pause',
      label: 'Pause Game',
      defaultKey: 'p',
      scope: 'phone',
      when: 'app:snek'
    };
    const restart: KeybindAction = {
      id: 'snek:restart',
      label: 'Restart',
      defaultKey: 'r',
      scope: 'phone',
      when: 'app:snek'
    };
    // Not a conflict against the default core candidate list — nothing core uses 'p',
    // and the app-declared action isn't even in that list.
    expect(conflictsWith(restart, 'p', {})).toBeUndefined();
    // ...but is one once the colliding app-declared action is passed in explicitly,
    // since both share `when: 'app:snek'`.
    const conflict = conflictsWith(restart, 'p', {}, [...PHONE_SCOPE_ACTIONS, pause, restart]);
    expect(conflict?.id).toBe('snek:pause');
  });

  it("flags an app-scoped action rebound onto an unscoped action's key", () => {
    // 'back' is unscoped (eligible everywhere), so an app-scoped action sharing its key
    // would always shadow 'back' while that app is foreground.
    const pause: KeybindAction = {
      id: 'snek:pause',
      label: 'Pause Game',
      defaultKey: 'p',
      scope: 'phone',
      when: 'app:snek'
    };
    const conflict = conflictsWith(pause, 'Backspace', {}, [...PHONE_SCOPE_ACTIONS, pause]);
    expect(conflict?.id).toBe('back');
  });

  it('does not flag a call-scoped action sharing a key with an unscoped action', () => {
    // 'back' and 'endCall' already share Backspace by design (call:any outranks
    // unscoped by dispatch precedence) — this pairing stays allowed.
    const back = findAction('back')!;
    expect(conflictsWith(back, 'Backspace', {})).toBeUndefined();
  });

  it('does not flag two app-scoped actions for different apps sharing a key', () => {
    const snekPause: KeybindAction = {
      id: 'snek:pause',
      label: 'Pause Game',
      defaultKey: 'p',
      scope: 'phone',
      when: 'app:snek'
    };
    const cameraPause: KeybindAction = {
      id: 'camera:pause',
      label: 'Pause Preview',
      defaultKey: 'p',
      scope: 'phone',
      when: 'app:camera'
    };
    const conflict = conflictsWith(cameraPause, 'p', {}, [
      ...PHONE_SCOPE_ACTIONS,
      snekPause,
      cameraPause
    ]);
    expect(conflict).toBeUndefined();
  });
});

/**
 * MICA-258: a device names the game-scope action that opens it, and the table has to hold
 * one for every device -- a tablet with no key is a tablet nobody can open, and the client
 * registers its commands from the same descriptor.
 */
describe('devices and their game-scope actions', () => {
  it.each(Object.values(DEVICES))('$id names its game-scope action and its command', (device) => {
    const action = findAction(device.keybind.id);
    expect(action).toBeDefined();
    expect(action!.scope).toBe('game');
    expect(action!.command).toBe(device.keybind.command);
    expect(action!.defaultKey).toBe(device.keybind.defaultKey);
  });

  it('gives every device a key of its own, so one press cannot mean two devices', () => {
    const keys = Object.values(DEVICES).map((d) => d.keybind.defaultKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no game-scope action that is not some device's", () => {
    const claimed = new Set(Object.values(DEVICES).map((d) => d.keybind.id));
    expect(GAME_SCOPE_ACTIONS.map((a) => a.id).filter((id) => !claimed.has(id))).toEqual([]);
  });
});
