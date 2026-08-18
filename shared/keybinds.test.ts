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
    const back = findAction('back')!;
    const appAction: KeybindAction = {
      id: 'snek:pause',
      label: 'Pause Game',
      defaultKey: 'k',
      scope: 'phone',
      when: 'app:snek'
    };
    // Not a conflict against the core list (nothing core uses 'k')...
    expect(conflictsWith(back, 'k', {})).toBeUndefined();
    // ...but is one once the app-declared action is passed in as a candidate.
    const conflict = conflictsWith(back, 'k', {}, [...PHONE_SCOPE_ACTIONS, appAction]);
    expect(conflict?.id).toBe('snek:pause');
  });
});
