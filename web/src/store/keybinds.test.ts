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
    expect(resolveAction('Escape', IDLE, get(bindings))?.id).toBe('back');
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

  it('leaves Backspace alone when no call is in progress', () => {
    // Otherwise the dispatcher would swallow it from the calculator and the dialler.
    expect(resolveAction('Backspace', IDLE, get(bindings))).toBeNull();
    expect(
      resolveAction('Backspace', { currentApp: 'home', callStatus: 'connected' }, get(bindings))?.id
    ).toBe('endCall');
  });

  it('honours an override over the default', () => {
    setBinding('back', 'q');
    expect(resolveAction('Escape', IDLE, get(bindings))).toBeNull();
    expect(resolveAction('q', IDLE, get(bindings))?.id).toBe('back');
  });

  it('restores defaults on reset', () => {
    setBinding('back', 'q');
    resetBindings();
    expect(get(bindings).back).toBe('Escape');
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

    const event = pressEvent('Escape');
    expect(dispatchKey(event, IDLE)).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);

    release();
  });

  it('does not fire while a text field has focus', () => {
    const handler = vi.fn();
    const release = registerHandler('back', handler);

    const event = pressEvent('Escape', document.createElement('textarea'));
    expect(dispatchKey(event, IDLE)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // The key must still reach the field, so the press stays unclaimed.
    expect(event.defaultPrevented).toBe(false);

    release();
  });

  it('does not claim a press no one has registered', () => {
    const event = pressEvent('Escape');
    expect(dispatchKey(event, IDLE)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('releasing a handler stops it firing', () => {
    const handler = vi.fn();
    registerHandler('back', handler)();
    expect(dispatchKey(pressEvent('Escape'), IDLE)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a later registration replaces an earlier one rather than both firing', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerHandler('back', first);
    const release = registerHandler('back', second);

    dispatchKey(pressEvent('Escape'), IDLE);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    release();
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
    dispatchKey(pressEvent('Escape'), IDLE);
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
    dispatchKey(pressEvent('Escape'), IDLE);
    expect(second).toHaveBeenCalledOnce();

    releaseSecond();
  });
});
