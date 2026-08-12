import { describe, expect, it, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  bindings,
  dispatchKey,
  isEligible,
  isTypingTarget,
  registerHandler,
  resetBindings,
  resolveAction,
  setBinding,
  type KeybindEnvironment
} from './keybinds';
import { findAction } from '@shared/keybinds';
import { useStorage } from '../../sdk/hooks/useStorage';

const IDLE: KeybindEnvironment = { currentApp: 'home', callStatus: 'idle' };

/** A KeyboardEvent stand-in that records whether the dispatcher claimed the press. */
const pressEvent = (key: string, target: EventTarget | null = null) => {
  let prevented = false;
  return {
    key,
    target,
    preventDefault: () => (prevented = true),
    get defaultPrevented() {
      return prevented;
    }
  } as unknown as KeyboardEvent & { defaultPrevented: boolean };
};

describe('keybind resolution', () => {
  beforeEach(() => resetBindings());

  it('resolves a key to its action', () => {
    expect(resolveAction('Backspace', IDLE, get(bindings))?.id).toBe('back');
    expect(resolveAction('Escape', IDLE, get(bindings))?.id).toBe('closePhone');
  });

  it('returns null for an unbound key', () => {
    expect(resolveAction('q', IDLE, get(bindings))).toBeNull();
  });

  it('gates an action on its `when` context', () => {
    const ringing = { currentApp: 'home', callStatus: 'incoming' };
    expect(resolveAction('Enter', IDLE, get(bindings))).toBeNull();
    expect(resolveAction('Enter', ringing, get(bindings))?.id).toBe('answerCall');
  });

  it('prefers a scoped action over an unscoped one on the same key', () => {
    setBinding('back', 'Enter');
    expect(
      resolveAction('Enter', { currentApp: 'camera', callStatus: 'idle' }, get(bindings))?.id
    ).toBe('shutter');
  });

  it('a ringing call outranks the app on screen', () => {
    // Enter is both Answer Call and the camera shutter. Both are eligible here, and the
    // call has to win — a missed call costs more than a missed photo.
    const both = { currentApp: 'camera', callStatus: 'incoming' };
    expect(resolveAction('Enter', both, get(bindings))?.id).toBe('answerCall');
  });

  it('the camera shutter still wins when nothing is ringing', () => {
    const camera = { currentApp: 'camera', callStatus: 'idle' };
    expect(resolveAction('Enter', camera, get(bindings))?.id).toBe('shutter');
  });

  it('Backspace hangs up during a call and navigates the rest of the time', () => {
    // `back` and `endCall` deliberately share a key. `endCall` is scoped to `call:any`
    // and a scoped action outranks an unscoped one, so which wins is decided by state
    // rather than by declaration order.
    expect(resolveAction('Backspace', IDLE, get(bindings))?.id).toBe('back');
    for (const callStatus of ['incoming', 'dialing', 'connected']) {
      expect(
        resolveAction('Backspace', { currentApp: 'home', callStatus }, get(bindings))?.id
      ).toBe('endCall');
    }
  });

  it('Escape always puts the phone away, whatever else is going on', () => {
    for (const env of [
      IDLE,
      { currentApp: 'camera', callStatus: 'idle' },
      { currentApp: 'messages', callStatus: 'connected' }
    ]) {
      expect(resolveAction('Escape', env, get(bindings))?.id).toBe('closePhone');
    }
  });

  it('honors an override over the default', () => {
    setBinding('back', 'q');
    expect(resolveAction('Backspace', IDLE, get(bindings))).toBeNull();
    expect(resolveAction('q', IDLE, get(bindings))?.id).toBe('back');
  });

  it('restores defaults on reset', () => {
    setBinding('back', 'q');
    resetBindings();
    expect(get(bindings).back).toBe('Backspace');
  });

  it('writes overrides to storage so a reload keeps them', () => {
    setBinding('back', 'q');
    expect(useStorage('settings').getItem<Record<string, string>>('keybinds')).toEqual({
      back: 'q'
    });
  });

  it('treats call:any as anything but idle', () => {
    const endCall = findAction('endCall')!;
    expect(isEligible(endCall, IDLE)).toBe(false);
    for (const callStatus of ['incoming', 'dialing', 'connected']) {
      expect(isEligible(endCall, { currentApp: 'home', callStatus })).toBe(true);
    }
  });
});

describe('typing guard', () => {
  it.each(['input', 'textarea', 'select'])('treats <%s> as typing', (tag) => {
    expect(isTypingTarget(document.createElement(tag))).toBe(true);
  });

  it('treats a contenteditable as typing', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    // jsdom does not implement isContentEditable off the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isTypingTarget(el)).toBe(true);
  });

  it('does not treat a plain element or null as typing', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('dispatchKey', () => {
  beforeEach(() => resetBindings());

  it('calls the registered handler and claims the press', () => {
    const handler = vi.fn();
    const release = registerHandler('back', handler);

    const event = pressEvent('Backspace');
    expect(dispatchKey(event, IDLE)).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);

    release();
  });

  it('does not fire while a text field has focus', () => {
    const handler = vi.fn();
    const release = registerHandler('back', handler);

    const event = pressEvent('Backspace', document.createElement('textarea'));
    expect(dispatchKey(event, IDLE)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // The key must still reach the field, so the press stays unclaimed.
    expect(event.defaultPrevented).toBe(false);

    release();
  });

  it('does not claim a press no one has registered', () => {
    const event = pressEvent('Backspace');
    expect(dispatchKey(event, IDLE)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('releasing a handler stops it firing', () => {
    const handler = vi.fn();
    registerHandler('back', handler)();
    expect(dispatchKey(pressEvent('Backspace'), IDLE)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a later registration replaces an earlier one rather than both firing', () => {
    const first = vi.fn();
    const second = vi.fn();
    // Both releases are held. `first` used to be discarded, which left an unscoped
    // handler in the registry for the rest of the file — the map is module state, so a
    // leak here silently props up every later test.
    const releaseFirst = registerHandler('back', first);
    const releaseSecond = registerHandler('back', second);

    dispatchKey(pressEvent('Backspace'), IDLE);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    releaseSecond();
    releaseFirst();
  });

  it('releasing an override restores the handler underneath it', () => {
    // The shell registers `back` once at startup and never again. If Settings claiming
    // it deleted the slot on unmount, Escape would stop working for the rest of the
    // session.
    const shell = vi.fn();
    const app = vi.fn();
    const releaseShell = registerHandler('back', shell);
    const releaseApp = registerHandler('back', app);

    releaseApp();
    dispatchKey(pressEvent('Backspace'), IDLE);
    expect(app).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();

    releaseShell();
  });

  it('a stale release does not unregister the handler that replaced it', () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = registerHandler('back', first);
    const releaseSecond = registerHandler('back', second);

    releaseFirst();
    dispatchKey(pressEvent('Backspace'), IDLE);
    expect(second).toHaveBeenCalledOnce();

    releaseSecond();
  });
});

describe('handler ownership under residency', () => {
  beforeEach(() => resetBindings());

  const inApp = (id: string): KeybindEnvironment => ({ currentApp: id, callStatus: 'idle' });

  it('routes back to the app on screen, not the one that registered last', () => {
    // The regression. Apps are resident and `Shell.svelte` renders them from a keyed
    // each-block, so re-opening an app reuses its component and never re-registers —
    // the stack records first-mount order forever. Open Notes, then Contacts, then
    // re-open Notes: the top of the stack is still Contacts.
    const shell = vi.fn();
    const notes = vi.fn();
    const contacts = vi.fn();

    const releaseShell = registerHandler('back', shell);
    const releaseNotes = registerHandler('back', notes, 'notes');
    const releaseContacts = registerHandler('back', contacts, 'contacts');

    dispatchKey(pressEvent('Backspace'), inApp('notes'));

    expect(notes).toHaveBeenCalledOnce();
    expect(contacts).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();

    releaseContacts();
    releaseNotes();
    releaseShell();
  });

  it('never lets a backgrounded app answer for the foreground one', () => {
    // Contacts is resident but hidden, and Phone has no ladder of its own. Back must
    // leave Phone rather than close something invisible inside Contacts.
    const shell = vi.fn();
    const contacts = vi.fn();

    const releaseShell = registerHandler('back', shell);
    const releaseContacts = registerHandler('back', contacts, 'contacts');

    dispatchKey(pressEvent('Backspace'), inApp('phone'));

    expect(contacts).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();

    releaseContacts();
    releaseShell();
  });

  it('falls back to the shell on the home screen', () => {
    const shell = vi.fn();
    const notes = vi.fn();

    const releaseShell = registerHandler('back', shell);
    const releaseNotes = registerHandler('back', notes, 'notes');

    dispatchKey(pressEvent('Backspace'), IDLE);

    expect(notes).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();

    releaseNotes();
    releaseShell();
  });

  it('still stacks two claims from the same app, deepest last', () => {
    // Ownership scopes the claim; it does not flatten it. A modal over a detail view
    // registers on top of the app's own ladder and hands it back on unmount.
    const ladder = vi.fn();
    const modal = vi.fn();

    const releaseLadder = registerHandler('back', ladder, 'notes');
    const releaseModal = registerHandler('back', modal, 'notes');

    dispatchKey(pressEvent('Backspace'), inApp('notes'));
    expect(modal).toHaveBeenCalledOnce();
    expect(ladder).not.toHaveBeenCalled();

    releaseModal();
    dispatchKey(pressEvent('Backspace'), inApp('notes'));
    expect(ladder).toHaveBeenCalledOnce();

    releaseLadder();
  });

  it('does not claim the press when only another app owns the action', () => {
    // Nothing eligible must leave the key alone, so the browser or a raw app listener
    // can still see it — the calculator's digits depend on `defaultPrevented`.
    const contacts = vi.fn();
    const release = registerHandler('back', contacts, 'contacts');

    const event = pressEvent('Backspace');
    expect(dispatchKey(event, inApp('notes'))).toBe(false);
    expect(contacts).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    release();
  });
});
