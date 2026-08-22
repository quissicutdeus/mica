import { derived, get } from 'svelte/store';
import { PHONE_SCOPE_ACTIONS, type KeybindAction } from '@shared/keybinds';
import { usePersisted } from '../../sdk/host/usePersisted';
import { appRegistryStore } from './registry';

/**
 * Resolved key bindings, plus the registry the dispatcher routes through.
 *
 * Overrides persist through `usePersisted` rather than raw `useStorage`, so they share the
 * `gphone:settings:*` namespace with the DevTools unlock and rehydrate when the server's
 * copy arrives — a plain `useStorage`-backed writable reads its key once at construction and
 * never learns about a later hydrate.
 */

const OVERRIDES_KEY = 'keybinds';

type Overrides = Record<string, string>;

const overrides = usePersisted<Overrides>('settings', OVERRIDES_KEY, {});

/**
 * A `KeybindAction` tagged with who owns it, for grouping in Settings > Shortcuts.
 * `ownerId: 'core'` for the static list; otherwise the declaring app's id.
 */
export interface ResolvedKeybindAction extends KeybindAction {
  ownerId: string;
  ownerLabel: string;
}

/**
 * App-declared actions, live off the installed-app registry.
 *
 * Only installed apps: an uninstalled add-on's binds must not occupy a key slot or show
 * in Shortcuts. Namespaced to `${appId}:${kb.id}` so two apps can each declare an action
 * called e.g. `pause` without colliding — and so an app can never collide with a core id.
 */
const appActions = derived(appRegistryStore, ($apps) =>
  $apps.flatMap((app): ResolvedKeybindAction[] =>
    (app.keybinds ?? []).map((kb) => ({
      id: `${app.id}:${kb.id}`,
      label: kb.label,
      defaultKey: kb.defaultKey,
      scope: 'phone' as const,
      when: `app:${app.id}` as const,
      ownerId: app.id,
      ownerLabel: app.name
    }))
  )
);

/** Every phone-scope action the dispatcher and Shortcuts screen know about, core first. */
export const allPhoneActions = derived(appActions, ($appActions): ResolvedKeybindAction[] => [
  ...PHONE_SCOPE_ACTIONS.map((a) => ({ ...a, ownerId: 'core', ownerLabel: 'Phone' })),
  ...$appActions
]);

/**
 * actionId -> the key currently bound to it.
 *
 * Phone-scope (core + app-declared) only — game-scope action ids (e.g. `openPhone`) are
 * never keys here. Those defaults live in `GAME_SCOPE_ACTIONS` and are rebound through
 * FiveM's own Key Bindings menu, not this store.
 */
export const bindings = derived([overrides, allPhoneActions], ([$overrides, $actions]) => {
  const resolved: Record<string, string> = {};
  for (const action of $actions) {
    resolved[action.id] = $overrides[action.id] ?? action.defaultKey;
  }
  return resolved;
});

export function setBinding(actionId: string, key: string) {
  overrides.update((current) => ({ ...current, [actionId]: key }));
}

export function resetBindings() {
  overrides.set({});
}

export function currentOverrides(): Overrides {
  return get(overrides);
}

// --- handler registry -------------------------------------------------------------

type Handler = () => void;

/**
 * Handlers registered by whichever components are mounted, as a stack per action.
 *
 * A stack rather than a single slot because the shell registers `back` once at startup
 * and never again: if an app claimed the slot and then deleted it on unmount, Escape
 * would stop working everywhere for the rest of the session.
 *
 * **A handler names the app that owns it**, and the top of the stack is not enough on its
 * own. Apps are resident, so an app is destroyed only on LRU eviction, and `Shell.svelte`
 * renders them from a *keyed* each-block — so re-opening a resident app reuses the
 * component and never re-registers. The stack therefore records first-mount order and
 * never learns which app is actually on screen. Open Notes, then Contacts, then re-open
 * Notes, and Backspace ran Contacts' handler: it closed an invisible detail view in a
 * backgrounded app while the app in front of you did nothing.
 *
 * `back` is the action this bites, because it is the one apps claim that has no `when`
 * (`shutter` is `app:camera`, so `isEligible` already scopes it). Scoping at the handler
 * is still the right layer: the *action* is global — the shell needs `back` too — and only
 * the *handler* belongs to one app.
 *
 * Shell handlers pass no `appId` and stay unscoped, which is what makes them the fallback
 * for home and for any app that never claimed the action.
 */
interface RegisteredHandler {
  handler: Handler;
  /** The app that owns this handler. Undefined for the shell's own. */
  appId?: string;
}

const handlers = new Map<string, RegisteredHandler[]>();

export function registerHandler(actionId: string, handler: Handler, appId?: string): () => void {
  const stack = handlers.get(actionId) ?? [];
  const entry: RegisteredHandler = { handler, appId };
  stack.push(entry);
  handlers.set(actionId, stack);

  return () => {
    // Remove this registration specifically. It may no longer be on top — an app can
    // unmount in any order relative to whatever registered after it. Keyed on the entry
    // rather than the function so registering the same handler twice stays unambiguous.
    const current = handlers.get(actionId);
    if (!current) return;
    const index = current.lastIndexOf(entry);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) handlers.delete(actionId);
  };
}

/**
 * The handler that would run for this action right now, if any.
 *
 * Topmost entry that is either unscoped or owned by the app on screen. A handler owned by
 * some *other* app is skipped rather than falling through to nothing, so a backgrounded
 * app can never answer for the foreground one.
 */
export const activeHandlerFor = (actionId: string, currentApp = 'home'): Handler | undefined => {
  const stack = handlers.get(actionId);
  if (!stack) return undefined;

  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.appId === undefined || entry.appId === currentApp) return entry.handler;
  }
  return undefined;
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
  resolvedBindings: Record<string, string>,
  actions: readonly KeybindAction[] = get(allPhoneActions)
): KeybindAction | null {
  const matches = actions.filter(
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

/**
 * Returns true when the press was consumed.
 *
 * `typing` defaults to a DOM check on `event.target`, which is meaningless for a key
 * forwarded from an add-on's iframe — that event's target is never a real focused
 * field in this document. The frame reports its own typing state over the host
 * protocol instead, and the shell passes it straight through.
 */
export function dispatchKey(
  event: KeyboardEvent,
  env: KeybindEnvironment,
  typing = isTypingTarget(event.target)
): boolean {
  if (typing) return false;

  const action = resolveAction(event.key, env, get(bindings));
  if (!action) return false;

  const handler = activeHandlerFor(action.id, env.currentApp);
  if (!handler) return false;

  event.preventDefault();
  handler();
  return true;
}
