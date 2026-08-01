import { writable, derived, get } from 'svelte/store';
import {
  KEYBIND_ACTIONS,
  PHONE_SCOPE_ACTIONS,
  type KeybindAction,
  type KeybindContext
} from '@shared/keybinds';
import { useStorage } from '../sdk/hooks/useStorage';

/**
 * Resolved key bindings, plus the registry the dispatcher routes through.
 *
 * Overrides persist through the SDK's storage hook rather than raw localStorage, so they
 * share the `gphone:settings:*` namespace with the DevTools unlock and inherit its
 * JSON handling and memory fallback.
 */

const storage = useStorage('settings');
const OVERRIDES_KEY = 'keybinds';

type Overrides = Record<string, string>;

const overrides = writable<Overrides>(storage.getItem<Overrides>(OVERRIDES_KEY, {}) ?? {});

/** actionId -> the key currently bound to it. */
export const bindings = derived(overrides, ($overrides) => {
  const resolved: Record<string, string> = {};
  for (const action of KEYBIND_ACTIONS) {
    resolved[action.id] = $overrides[action.id] ?? action.defaultKey;
  }
  return resolved;
});

export function setBinding(actionId: string, key: string) {
  overrides.update((current) => {
    const next = { ...current, [actionId]: key };
    storage.setItem(OVERRIDES_KEY, next);
    return next;
  });
}

export function resetBindings() {
  overrides.set({});
  storage.setItem(OVERRIDES_KEY, {});
}

export function currentOverrides(): Overrides {
  return get(overrides);
}

// --- handler registry -------------------------------------------------------------

type Handler = () => void;

/**
 * Handlers registered by whichever components are mounted, as a stack per action.
 *
 * Only the top of the stack fires, so a mounted app overrides the shell rather than both
 * running. A stack rather than a single slot because the shell registers `back` once at
 * startup and never again: if an app claimed the slot and then deleted it on unmount,
 * Escape would stop working everywhere for the rest of the session.
 */
const handlers = new Map<string, Handler[]>();

export function registerHandler(actionId: string, handler: Handler): () => void {
  const stack = handlers.get(actionId) ?? [];
  stack.push(handler);
  handlers.set(actionId, stack);

  return () => {
    // Remove this handler specifically. It may no longer be on top — an app can unmount
    // in any order relative to whatever registered after it.
    const current = handlers.get(actionId);
    if (!current) return;
    const index = current.lastIndexOf(handler);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) handlers.delete(actionId);
  };
}

/** The handler that would run for this action right now, if any. */
const activeHandler = (actionId: string): Handler | undefined => {
  const stack = handlers.get(actionId);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
};

// --- dispatch ---------------------------------------------------------------------

/** What the shell knows at dispatch time. */
export interface KeybindEnvironment {
  currentApp: string;
  callStatus: string;
}

/** Does this action's `when` hold right now? */
export function isEligible(action: KeybindAction, env: KeybindEnvironment): boolean {
  if (!action.when) return true;
  if (action.when === 'call:incoming') return env.callStatus === 'incoming';
  if (action.when === 'call:active') return env.callStatus === 'connected';
  if (action.when === 'call:any') return env.callStatus !== 'idle';
  if (action.when.startsWith('app:')) return env.currentApp === action.when.slice(4);
  return false;
}

/**
 * True when the player is typing, in which case no bind may fire.
 *
 * Without this, `Enter` in the message composer would also trip the camera shutter, and
 * a letter bound to an action would be swallowed instead of typed.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;

  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

/**
 * Resolve a keypress to the action that should run, or null.
 *
 * Exported separately from the side effect so the precedence rules are unit-testable
 * without a DOM.
 */
export function resolveAction(
  key: string,
  env: KeybindEnvironment,
  resolvedBindings: Record<string, string>
): KeybindAction | null {
  const matches = PHONE_SCOPE_ACTIONS.filter(
    (action) => resolvedBindings[action.id] === key && isEligible(action, env)
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Declaration order must not decide this, so rank explicitly. A call outranks the app
  // on screen: Enter with the camera open is the shutter, but if the phone is also
  // ringing it answers, because a missed call costs more than a missed photo. Anything
  // scoped outranks an unscoped action on the same key.
  const rank = (action: KeybindAction): number => {
    if (action.when?.startsWith('call:')) return 0;
    if (action.when?.startsWith('app:')) return 1;
    return 2;
  };
  return matches.reduce((best, candidate) => (rank(candidate) < rank(best) ? candidate : best));
}

/** Returns true when the press was consumed. */
export function dispatchKey(event: KeyboardEvent, env: KeybindEnvironment): boolean {
  if (isTypingTarget(event.target)) return false;

  const action = resolveAction(event.key, env, get(bindings));
  if (!action) return false;

  const handler = activeHandler(action.id);
  if (!handler) return false;

  event.preventDefault();
  handler();
  return true;
}
