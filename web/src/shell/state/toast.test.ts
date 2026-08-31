// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast, closedPhoneToast } from './toast';
import { get } from 'svelte/store';
import { shadeNotifications } from '../../services/notifications';
import { appNotificationPolicies, dndEnabled } from './notificationPolicy';
import { toastsEnabled } from './notificationSettings';
import { audio } from './audio';
import { isPhoneOpen } from './phoneOpen';

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
      senderLabel: 'Alice',
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

  /**
   * MICA-155: `contacts.share` lets someone forward any saved card, so the card's own
   * claimed name is never provenance — a card saying "John Doe" from a player whose real
   * identity is someone else entirely must still surface who actually sent it, in what
   * actually renders (the title `ToastHost.svelte` paints), not merely in data the toast
   * carries but never shows.
   */
  it('shows the true sender even when the card claims an unrelated name', () => {
    toast.showContactShare({
      name: 'John Doe',
      phone: '555-0199',
      senderLabel: 'Trevor Philips',
      onAccept: () => {}
    });

    const [active] = get(toast);
    expect(active.title).toContain('Trevor Philips');
    expect(active.title).not.toContain('John Doe');
    // The claimed card identity still renders too — in the message, not the title — so
    // the player can see both and judge whether they agree.
    expect(active.message).toBe('John Doe (555-0199)');
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
      () => toast.showContactShare({ name: 'x', phone: 'y', senderLabel: 'z', onAccept: () => {} }),
      'contacts'
    ],
    ['showCall', () => toast.showCall({ number: 'x', onAccept: () => {} }), 'phone']
  ])('%s tags its own app', (_name, trigger, app) => {
    trigger();
    expect(get(toast)[0].app).toBe(app);
  });
});

describe('toast policy enforcement (MICA-63)', () => {
  beforeEach(() => {
    toast.clear();
    shadeNotifications.set([]);
    dndEnabled.set(false);
    appNotificationPolicies.set({});
    toastsEnabled.set(true);
  });

  /**
   * The claim the whole design rests on: a mute suppresses the *interruption* and never the
   * *record*. The row is written before the banner is judged, so a muted app's notification is
   * still in the shade when the player goes looking — which is what makes turning DND off
   * non-destructive, and what a server-side mute could not have offered.
   */
  it.each([
    [
      'a per-app banner mute',
      () => appNotificationPolicies.set({ blabber: { banner: false, sound: true, badge: true } })
    ],
    ['do not disturb', () => dndEnabled.set(true)],
    ['the global banner switch', () => toastsEnabled.set(false)]
  ])('still writes the shade row when the banner is suppressed by %s', (_label, mute) => {
    mute();
    toast.show({ source: 'app', app: 'blabber', message: '@you were mentioned' });

    expect(get(toast)).toHaveLength(0);
    expect(get(shadeNotifications)).toHaveLength(1);
    expect(get(shadeNotifications)[0].body).toBe('@you were mentioned');
  });

  it('returns an id for a suppressed toast, so a caller can still dismiss it blind', () => {
    dndEnabled.set(true);
    const id = toast.show({ source: 'app', app: 'blabber', message: 'hi' });

    expect(id).toBeTruthy();
    expect(() => toast.dismiss(id)).not.toThrow();
  });

  it('shows a call banner under DND — it carries the only Accept button there is', () => {
    dndEnabled.set(true);
    appNotificationPolicies.set({ phone: { banner: false, sound: false, badge: false } });

    toast.showCall({ number: '5551234', onAccept: () => {} });
    expect(get(toast)).toHaveLength(1);
    expect(get(toast)[0].type).toBe('call');
  });

  it('shows a system message under DND and every global switched off', () => {
    dndEnabled.set(true);
    toastsEnabled.set(false);

    toast.show({ source: 'system', type: 'warning', message: 'You have been warned' });
    expect(get(toast)).toHaveLength(1);
  });

  it('does not suppress an unclassified feedback toast', () => {
    dndEnabled.set(true);
    toastsEnabled.set(false);

    toast.show({ app: 'contacts', message: 'Contact added to address book' });
    expect(get(toast)).toHaveLength(1);
  });

  it('suppresses the arrival sound for a muted app but still shows the banner', () => {
    appNotificationPolicies.set({ mail: { banner: true, sound: false, badge: true } });
    const play = vi.spyOn(audio, 'play');

    toast.showMail({ sender: 'HR', subject: 'Payslip' });

    expect(play).not.toHaveBeenCalled();
    expect(get(toast)).toHaveLength(1);
    play.mockRestore();
  });
});

describe('closed-phone peek (MICA-141)', () => {
  beforeEach(() => {
    toast.clear();
    shadeNotifications.set([]);
    dndEnabled.set(false);
    appNotificationPolicies.set({});
    toastsEnabled.set(true);
    isPhoneOpen.set(false);
    closedPhoneToast.set(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    isPhoneOpen.set(false);
    closedPhoneToast.set(null);
    vi.useRealTimers();
  });

  it('populates the peek and plays the chime for a generic arrival while the phone is closed', () => {
    const play = vi.spyOn(audio, 'play');

    toast.show({ source: 'app', app: 'blabber', title: 'Blabber', message: '@you were mentioned' });

    expect(play).toHaveBeenCalledWith('notification');
    expect(get(closedPhoneToast)?.message).toBe('@you were mentioned');
    play.mockRestore();
  });

  it('auto-dismisses the peek on its own after a few seconds', () => {
    toast.show({ source: 'app', app: 'blabber', message: 'hi' });
    expect(get(closedPhoneToast)).not.toBeNull();

    vi.advanceTimersByTime(3500);
    expect(get(closedPhoneToast)).toBeNull();
  });

  it('does nothing when the phone is already open — ToastHost owns that case', () => {
    isPhoneOpen.set(true);
    const play = vi.spyOn(audio, 'play');

    toast.show({ source: 'app', app: 'blabber', message: 'hi' });

    expect(play).not.toHaveBeenCalled();
    expect(get(closedPhoneToast)).toBeNull();
    play.mockRestore();
  });

  it('opening the phone mid-peek clears it — the real banner takes over', () => {
    toast.show({ source: 'app', app: 'blabber', message: 'hi' });
    expect(get(closedPhoneToast)).not.toBeNull();

    isPhoneOpen.set(true);
    expect(get(closedPhoneToast)).toBeNull();
  });

  it('does not double up the chime for a type that already played its own', () => {
    const play = vi.spyOn(audio, 'play');

    toast.showMail({ sender: 'HR', subject: 'Payslip' });

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith('notification');
    // The banner peek still shows — only the extra chime is what soundHandled suppresses.
    expect(get(closedPhoneToast)?.title).toBe('New Email: HR');
    play.mockRestore();
  });

  it('excludes an unclassified feedback toast — it confirms an action the player just took', () => {
    const play = vi.spyOn(audio, 'play');

    toast.show({ app: 'contacts', message: 'Contact added to address book' });

    expect(play).not.toHaveBeenCalled();
    expect(get(closedPhoneToast)).toBeNull();
    play.mockRestore();
  });

  it('excludes an incoming call — it keeps its own ringtone and Accept/Decline story', () => {
    const play = vi.spyOn(audio, 'play');

    toast.showCall({ number: '555-0100', onAccept: () => {} });

    // showCall's own ringtone check still runs; the closed-phone chime never fires on top.
    expect(play.mock.calls.filter(([effect]) => effect === 'notification')).toHaveLength(0);
    expect(get(closedPhoneToast)).toBeNull();
    play.mockRestore();
  });
});
