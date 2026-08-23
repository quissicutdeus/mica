// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from './toast';
import { get } from 'svelte/store';
import { shadeNotifications } from '../../services/notifications';

describe('toast store interactive notifications', () => {
  beforeEach(() => {
    toast.clear();
    vi.useFakeTimers();
  });

  it('creates incoming message toast with interactive reply configuration', () => {
    const onReplySpy = vi.fn();
    toast.showIncomingMessage({
      sender: 'Trevor Philips',
      message: 'Meet me at Sandy Shores airfield',
      onReply: onReplySpy
    });

    const activeToasts = get(toast);
    expect(activeToasts).toHaveLength(1);
    expect(activeToasts[0].type).toBe('message');
    expect(activeToasts[0].sender).toBe('Trevor Philips');
    expect(activeToasts[0].hasReplyInput).toBe(true);

    activeToasts[0].onReply?.('On my way!');
    expect(onReplySpy).toHaveBeenCalledWith('On my way!');
  });

  it('pauses dismiss timer on focus/hover and resumes on blur', () => {
    const id = toast.show({
      message: 'Test pause',
      duration: 1000
    });

    expect(get(toast)).toHaveLength(1);

    // Pause timer
    toast.pauseDismiss(id);
    vi.advanceTimersByTime(2000);
    // Should STILL be present because it was paused
    expect(get(toast)).toHaveLength(1);

    // Resume timer with 500ms delay
    toast.resumeDismiss(id, 500);
    vi.advanceTimersByTime(600);
    // Now it should be dismissed
    expect(get(toast)).toHaveLength(0);
  });

  it('creates contact share toast with standardized Accept and Decline actions', async () => {
    const acceptSpy = vi.fn();
    const declineSpy = vi.fn();

    toast.showContactShare({
      name: 'John Doe',
      phone: '555-0199',
      onAccept: acceptSpy,
      onDecline: declineSpy
    });

    const activeToasts = get(toast);
    expect(activeToasts).toHaveLength(1);
    expect(activeToasts[0].type).toBe('contact');
    expect(activeToasts[0].actions).toHaveLength(2);

    expect(activeToasts[0].actions?.[0].label).toBe('Accept');
    expect(activeToasts[0].actions?.[1].label).toBe('Decline');

    await activeToasts[0].actions?.[0].onClick();
    expect(acceptSpy).toHaveBeenCalledOnce();

    await activeToasts[0].actions?.[1].onClick();
    expect(declineSpy).toHaveBeenCalledOnce();
  });

  it('creates incoming call toast with standardized Accept and Decline actions', async () => {
    const acceptSpy = vi.fn();
    const declineSpy = vi.fn();

    toast.showCall({
      name: 'Lester Crest',
      number: '555-0155',
      onAccept: acceptSpy,
      onDecline: declineSpy
    });

    const activeToasts = get(toast);
    expect(activeToasts).toHaveLength(1);
    expect(activeToasts[0].type).toBe('call');
    expect(activeToasts[0].actions).toHaveLength(2);

    expect(activeToasts[0].actions?.[0].label).toBe('Accept');
    expect(activeToasts[0].actions?.[1].label).toBe('Decline');

    await activeToasts[0].actions?.[0].onClick();
    expect(acceptSpy).toHaveBeenCalledOnce();
  });

  it('creates email toast notification', () => {
    const onClickSpy = vi.fn();

    toast.showMail({
      sender: 'Fleeca Bank',
      subject: 'Monthly Statement Available',
      onClick: onClickSpy
    });

    const activeToasts = get(toast);
    expect(activeToasts).toHaveLength(1);
    expect(activeToasts[0].title).toBe('New Email: Fleeca Bank');

    activeToasts[0].onClick?.();
    expect(onClickSpy).toHaveBeenCalledOnce();
  });
});

describe('toast swipe actions', () => {
  beforeEach(() => {
    toast.clear();
    shadeNotifications.set([]);
  });

  it('carries the id of the drawer notification it created', () => {
    toast.show({ message: 'Hi' });
    const [t] = get(toast);
    const [shadeItem] = get(shadeNotifications);

    expect(t.notificationId).toBe(shadeItem.id);
  });

  it('archive() removes the toast and clears the underlying notification from the drawer', async () => {
    const id = toast.show({ message: 'Hi' });
    expect(get(shadeNotifications)).toHaveLength(1);

    await toast.archive(id);

    expect(get(toast)).toHaveLength(0);
    expect(get(shadeNotifications)).toHaveLength(0);
  });

  it('dismiss() removes the toast but leaves the notification in the drawer', () => {
    const id = toast.show({ message: 'Hi' });

    toast.dismiss(id);

    expect(get(toast)).toHaveLength(0);
    expect(get(shadeNotifications)).toHaveLength(1);
  });
});

describe('toast queue — only one visible at a time', () => {
  beforeEach(() => {
    toast.clear();
    vi.useFakeTimers();
  });

  it('keeps only one toast visible when a second show() arrives while one is up', () => {
    toast.show({ message: 'First', title: 'A' });
    toast.show({ message: 'Second', title: 'B' });

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].title).toBe('A');
  });

  it('shows the next queued toast automatically once the visible one is dismissed', () => {
    const firstId = toast.show({ message: 'First', title: 'A' });
    toast.show({ message: 'Second', title: 'B' });

    toast.dismiss(firstId);

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].title).toBe('B');
  });

  it('shows queued toasts in the order they arrived', () => {
    const firstId = toast.show({ message: 'First', title: 'A' });
    toast.show({ message: 'Second', title: 'B' });
    toast.show({ message: 'Third', title: 'C' });

    toast.dismiss(firstId);
    expect(get(toast)[0].title).toBe('B');

    toast.dismiss(get(toast)[0].id);
    expect(get(toast)[0].title).toBe('C');
  });

  it('advances the queue when the visible toast expires on its own timer', () => {
    toast.show({ message: 'First', title: 'A', duration: 1000 });
    toast.show({ message: 'Second', title: 'B' });

    vi.advanceTimersByTime(1000);

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].title).toBe('B');
  });

  it('collapses a repeat from the same sender while queued, keeping only the latest', () => {
    toast.show({ message: 'First', title: 'A' }); // visible
    toast.show({ message: 'One', sender: 'Trevor' }); // queued
    toast.show({ message: 'Two', sender: 'Trevor' }); // should replace the queued one, not add a second

    toast.dismiss(get(toast)[0].id);

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].message).toBe('Two');
  });

  it('lets a call toast interrupt the current visible toast immediately', () => {
    toast.show({ message: 'First', title: 'A' });
    toast.showCall({ number: '555-0100', onAccept: () => {} });

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].type).toBe('call');
  });

  it('resumes the interrupted toast after the call toast is dismissed', () => {
    const firstId = toast.show({ message: 'First', title: 'A' });
    toast.showCall({ number: '555-0100', onAccept: () => {} });
    const callId = get(toast)[0].id;

    toast.dismiss(callId);

    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].id).toBe(firstId);
  });

  it('clear() empties the queue too, not just the visible toast', () => {
    toast.show({ message: 'First', title: 'A' }); // visible
    toast.show({ message: 'Second', title: 'B' }); // queued

    toast.clear();

    const freshId = toast.show({ message: 'Fresh' });
    toast.dismiss(freshId);

    // If the queue had survived clear(), the stale 'Second' toast would surface here.
    expect(get(toast)).toHaveLength(0);
  });
});

describe('a toast carries which app it came from', () => {
  beforeEach(() => toast.clear());

  it('stores the app id passed to the generic show()', () => {
    toast.show({ message: 'Hi', app: 'notes' });
    expect(get(toast)[0].app).toBe('notes');
  });

  it('has no app id when none is given', () => {
    toast.show({ message: 'Hi' });
    expect(get(toast)[0].app).toBeUndefined();
  });

  it.each([
    ['showMail', () => toast.showMail({ sender: 'x', subject: 'y' }), 'mail'],
    [
      'showIncomingMessage',
      () => toast.showIncomingMessage({ sender: 'x', message: 'y', onReply: () => {} }),
      'messages'
    ],
    [
      'showContactShare',
      () => toast.showContactShare({ name: 'x', phone: 'y', onAccept: () => {} }),
      'contacts'
    ],
    ['showCall', () => toast.showCall({ number: 'x', onAccept: () => {} }), 'phone']
  ])('%s tags its own app', (_name, trigger, app) => {
    trigger();
    expect(get(toast)[0].app).toBe(app);
  });
});
