// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useAppLevels } from './useAppLevels';
import { dispatchKey } from '../../shell/state/keybinds';

// The real dispatch path, so these prove the shell would actually route Backspace here —
// not merely that a handler landed in a map.
const pressBack = (currentApp = 'notes') =>
  dispatchKey(new KeyboardEvent('keydown', { key: 'Backspace' }), {
    currentApp,
    callStatus: 'idle'
  });

describe('useAppLevels', () => {
  it('closes the deepest open level, one press at a time', () => {
    let modal = false;
    let detail = false;
    const onback = vi.fn();

    const app = useAppLevels({
      appId: 'notes',
      title: 'Notes',
      onback,
      levels: [
        { open: () => modal, close: () => (modal = false) },
        { open: () => detail, close: () => (detail = false) }
      ]
    });

    detail = true;
    modal = true;

    app.back();
    expect([modal, detail]).toEqual([false, true]);
    expect(onback).not.toHaveBeenCalled();

    app.back();
    expect([modal, detail]).toEqual([false, false]);
    expect(onback).not.toHaveBeenCalled();

    app.back();
    expect(onback).toHaveBeenCalledTimes(1);
    app.release();
  });

  it('reads level state when back is pressed, not when it is declared', () => {
    // Every level is closed at declaration time; the ladder still has to see the state
    // the app is actually in.
    let detail = false;
    const onback = vi.fn();
    const app = useAppLevels({
      appId: 'photos',
      title: 'Photos',
      onback,
      levels: [{ open: () => detail, close: () => (detail = false) }]
    });

    detail = true;
    app.back();

    expect(detail).toBe(false);
    expect(onback).not.toHaveBeenCalled();
    app.release();
  });

  it('claims the back action, so the shell cannot pre-empt it', () => {
    // The defect this removes: Notes and Contacts each defined a ladder and forgot to
    // register it, so Backspace left the app from a detail view. Declaring the levels is
    // now the same act as claiming the key — there is no second step to forget.
    let detail = true;
    const onback = vi.fn();
    const app = useAppLevels({
      appId: 'notes',
      title: 'Notes',
      onback,
      levels: [{ open: () => detail, close: () => (detail = false) }]
    });

    pressBack();

    expect(detail).toBe(false);
    expect(onback).not.toHaveBeenCalled();
    app.release();
  });

  it('does not answer for another app that is on screen', () => {
    // Apps are resident, so this ladder stays registered while Notes sits hidden behind
    // whatever the player opened next. Without `appId` the dispatcher ran the topmost
    // handler regardless, and Backspace in Contacts closed a detail view inside Notes.
    let detail = true;
    const onback = vi.fn();
    const app = useAppLevels({
      appId: 'notes',
      title: 'Notes',
      onback,
      levels: [{ open: () => detail, close: () => (detail = false) }]
    });

    pressBack('contacts');

    expect(detail).toBe(true);
    expect(onback).not.toHaveBeenCalled();
    app.release();
  });

  it('hands the action back when the app releases it', () => {
    let detail = true;
    const app = useAppLevels({
      appId: 'notes',
      title: 'Notes',
      levels: [{ open: () => detail, close: () => (detail = false) }]
    });

    app.release();
    pressBack();

    expect(detail).toBe(true);
  });

  it('titles itself from the deepest open level that has one', () => {
    let editing = false;
    let detail = false;
    const app = useAppLevels({
      appId: 'notes',
      title: 'Notes',
      levels: [
        { open: () => editing, close: () => (editing = false), title: 'Edit Note' },
        { open: () => detail, close: () => (detail = false), title: () => 'Shopping list' }
      ]
    });

    expect(app.title).toBe('Notes');

    detail = true;
    expect(app.title).toBe('Shopping list');

    editing = true;
    expect(app.title).toBe('Edit Note');
    app.release();
  });

  it('skips levels with no title of their own', () => {
    // A confirmation dialog is a level for the purpose of back, but it is not a screen
    // and must not rename the header behind it.
    let confirming = false;
    let detail = false;
    const app = useAppLevels({
      appId: 'photos',
      title: 'Photos',
      levels: [
        { open: () => confirming, close: () => (confirming = false) },
        { open: () => detail, close: () => (detail = false), title: 'Photo' }
      ]
    });

    detail = true;
    confirming = true;
    expect(app.title).toBe('Photo');
    app.release();
  });
});
