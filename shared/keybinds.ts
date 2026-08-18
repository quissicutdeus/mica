/**
 * Every keyboard action the phone answers to, declared once.
 *
 * Two dispatch paths, because FiveM forces the split: opening the phone calls
 * `SetNuiFocus(true, true)` with no keep-input, so the game receives no control input
 * while the phone is open. A `RegisterKeyMapping` therefore cannot fire in-phone, and
 * FiveM's native rebinding UI cannot reach any in-phone key.
 *
 *   scope 'game'  — registered with RegisterKeyMapping. Rebindable in FiveM's own
 *                   Key Bindings menu. Only useful while the phone is closed.
 *   scope 'phone' — dispatched by web/'s keydown handler. Rebindable in gPhone's own
 *                   Settings > Shortcuts, since FiveM's menu cannot see these.
 *
 * Keys are compared against `KeyboardEvent.key` for phone scope; game scope uses FiveM's
 * key name, which is why the two are not interchangeable.
 */

type KeybindScope = 'game' | 'phone';

/**
 * When an action is eligible. Omitted means "whenever the phone is open".
 *
 * `app:<id>` matches the foreground app; the call contexts match `callStore.status`.
 * `call:any` covers everything except idle — ringing, dialing, or connected.
 */
export type KeybindContext = 'call:incoming' | 'call:active' | 'call:any' | `app:${string}`;

export interface KeybindAction {
  id: string;
  /** Shown in gPhone's Shortcuts screen, and as the FiveM mapping description. */
  label: string;
  defaultKey: string;
  scope: KeybindScope;
  when?: KeybindContext;
  /**
   * Game scope only: the `RegisterCommand` name the mapping invokes. Defaults to `id`,
   * and exists so an already-published command name stays stable when the action id
   * reads better as something else.
   */
  command?: string;
}

export const KEYBIND_ACTIONS: readonly KeybindAction[] = [
  {
    id: 'openPhone',
    label: 'Open Phone',
    defaultKey: 'm',
    scope: 'game',
    // Predates the table; players already have `togglePhone` bound in their FiveM config
    // and renaming it would silently drop their binding.
    command: 'togglePhone'
  },
  {
    id: 'answerCall',
    label: 'Answer Call',
    defaultKey: 'Enter',
    scope: 'phone',
    when: 'call:incoming'
  },
  {
    id: 'endCall',
    // One action for both: declining a ringing call and hanging up an active one are the
    // same thing client-side, so binding them separately would be a distinction without
    // a difference.
    label: 'End / Reject Call',
    defaultKey: 'Backspace',
    scope: 'phone',
    // Scoped so Backspace stays an ordinary key with no call in progress — otherwise the
    // dispatcher would swallow it from the calculator and the dialler.
    when: 'call:any'
  },
  {
    id: 'shutter',
    label: 'Take Photo',
    defaultKey: 'Enter',
    scope: 'phone',
    when: 'app:camera'
  },
  {
    id: 'back',
    label: 'Back',
    // Backspace, not Escape: back is a navigation step, and Escape is now reserved for
    // putting the phone away entirely. They were one action and that made "up one
    // level" and "leave" impossible to express separately.
    //
    // It shares a key with End Call, which is fine — that action is scoped to
    // `call:any` and a scoped action outranks an unscoped one, so Backspace hangs up
    // during a call and navigates the rest of the time.
    //
    // Apps that have their own levels claim this and decide: the calculator deletes a
    // digit before it will leave, Messages closes a thread before the app.
    defaultKey: 'Backspace',
    scope: 'phone'
  },
  {
    id: 'closePhone',
    label: 'Put Phone Away',
    defaultKey: 'Escape',
    scope: 'phone'
  },
  {
    id: 'freelook',
    label: 'Freelook (hold)',
    defaultKey: 'Alt',
    scope: 'phone'
  }
] as const;

export const PHONE_SCOPE_ACTIONS = KEYBIND_ACTIONS.filter((a) => a.scope === 'phone');
export const GAME_SCOPE_ACTIONS = KEYBIND_ACTIONS.filter((a) => a.scope === 'game');

export const findAction = (id: string): KeybindAction | undefined =>
  KEYBIND_ACTIONS.find((a) => a.id === id);

/**
 * Note `answerCall` and `shutter` share `Enter`. That is fine and deliberate — their
 * `when` contexts are disjoint, so only one is ever eligible. The Shortcuts screen only
 * rejects a duplicate when two actions could fire from the same key at the same time.
 */
export function conflictsWith(
  action: KeybindAction,
  key: string,
  bindings: Record<string, string>,
  candidates: readonly KeybindAction[] = PHONE_SCOPE_ACTIONS
): KeybindAction | undefined {
  return candidates.find((other) => {
    if (other.id === action.id) return false;
    if ((bindings[other.id] ?? other.defaultKey) !== key) return false;
    // Different contexts can never be eligible together; the same context can.
    return other.when === action.when;
  });
}
