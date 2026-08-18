import { describe, expect, it } from 'vitest';
import { conflictsWith, findAction, PHONE_SCOPE_ACTIONS, type KeybindAction } from './keybinds';

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
