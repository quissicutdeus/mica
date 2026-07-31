import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from './toast';
import { get } from 'svelte/store';

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
