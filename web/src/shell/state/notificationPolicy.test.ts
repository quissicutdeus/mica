// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  appNotificationPolicies,
  badgeAllowedFor,
  callBreaksThrough,
  clearAppNotificationPolicy,
  customisedNotificationApps,
  dndEnabled,
  notificationAllows,
  policyForApp,
  REPEAT_CALL_WINDOW_MS,
  setAppNotificationPolicy,
  __resetCallHistory
} from './notificationPolicy';
import { badgesEnabled, notificationSoundEnabled, toastsEnabled } from './notificationSettings';
import { contacts } from '../../services/contacts';
import type { Contact } from '@shared/types';

const contact = (phone: string, favorite: boolean): Contact =>
  ({ id: 1, citizenid: 'me', firstname: 'A', lastname: 'B', phone, favorite }) as Contact;

describe('notification policy (MICA-63)', () => {
  beforeEach(() => {
    dndEnabled.set(false);
    appNotificationPolicies.set({});
    toastsEnabled.set(true);
    notificationSoundEnabled.set(true);
    badgesEnabled.set(true);
    contacts.set([]);
    __resetCallHistory();
    vi.useRealTimers();
  });

  describe('defaults', () => {
    it('allows every channel for an app with no override', () => {
      for (const channel of ['banner', 'sound', 'badge'] as const) {
        expect(notificationAllows(channel, { source: 'app', app: 'blabber' })).toBe(true);
      }
    });

    it('treats an unclassified toast as feedback and never suppresses it', () => {
      // The default matters: a toast confirming something the player just did must not be
      // swallowed, and a new arrival path that forgets to classify itself should fail loud
      // (an unhonoured mute) rather than silent (a notification nobody ever sees).
      dndEnabled.set(true);
      toastsEnabled.set(false);
      expect(notificationAllows('banner', {})).toBe(true);
      expect(notificationAllows('banner', { app: 'contacts' })).toBe(true);
    });
  });

  describe('per-app overrides', () => {
    it('silences one app on one channel and leaves the others alone', () => {
      setAppNotificationPolicy('blabber', { banner: false });

      expect(notificationAllows('banner', { source: 'app', app: 'blabber' })).toBe(false);
      expect(notificationAllows('sound', { source: 'app', app: 'blabber' })).toBe(true);
      expect(notificationAllows('badge', { source: 'app', app: 'blabber' })).toBe(true);
      expect(notificationAllows('banner', { source: 'app', app: 'mail' })).toBe(true);
    });

    it('writes a complete triple so a stored entry never needs merging on read', () => {
      setAppNotificationPolicy('blabber', { sound: false });
      expect(get(appNotificationPolicies).blabber).toEqual({
        banner: true,
        sound: false,
        badge: true
      });
    });

    it('is ANDed with the global master, which can only make things quieter', () => {
      toastsEnabled.set(false);
      setAppNotificationPolicy('mail', { banner: true });
      expect(notificationAllows('banner', { source: 'app', app: 'mail' })).toBe(false);
    });

    it('forgets an app on clear, so a reinstall starts allowed', () => {
      setAppNotificationPolicy('blabber', { banner: false });
      clearAppNotificationPolicy('blabber');

      expect(get(appNotificationPolicies)).toEqual({});
      expect(notificationAllows('banner', { source: 'app', app: 'blabber' })).toBe(true);
    });

    it('keys on a bare string, so an ext_ group is mutable like any app', () => {
      setAppNotificationPolicy('ext_some_resource', { banner: false });
      expect(notificationAllows('banner', { source: 'app', app: 'ext_some_resource' })).toBe(false);
    });

    it('lists only the apps the player has actually made quieter', () => {
      setAppNotificationPolicy('blabber', { banner: false });
      setAppNotificationPolicy('mail', { banner: true });
      expect(get(customisedNotificationApps)).toEqual(['blabber']);
    });
  });

  describe('stored data outliving the code that wrote it', () => {
    it.each([
      ['not an object', 'nonsense'],
      ['an array', [1, 2, 3]],
      ['null', null]
    ])('falls back to an empty map when the stored value is %s', (_label, stored) => {
      appNotificationPolicies.set(stored as never);
      expect(get(appNotificationPolicies)).toEqual({});
    });

    it('rebuilds a partial or malformed entry rather than trusting it', () => {
      appNotificationPolicies.set({
        blabber: { banner: false } as never,
        mail: 'nope' as never
      });

      expect(get(appNotificationPolicies)).toEqual({
        blabber: { banner: false, sound: true, badge: true }
      });
    });

    it('reads a missing app as fully allowed', () => {
      expect(policyForApp(undefined, {})).toEqual({ banner: true, sound: true, badge: true });
      expect(policyForApp('nobody', {})).toEqual({ banner: true, sound: true, badge: true });
    });
  });

  describe('do not disturb', () => {
    it('suppresses an app banner and sound', () => {
      dndEnabled.set(true);
      expect(notificationAllows('banner', { source: 'app', app: 'blabber' })).toBe(false);
      expect(notificationAllows('sound', { source: 'app', app: 'blabber' })).toBe(false);
    });

    it('leaves the badge alone — a badge is not an interruption', () => {
      // Suppress the interruption, never the record. A DND that hid the count would leave a
      // player unable to tell they had missed anything while it was on.
      dndEnabled.set(true);
      expect(notificationAllows('badge', { source: 'app', app: 'blabber' })).toBe(true);
      expect(badgeAllowedFor('blabber')).toBe(true);
    });
  });

  describe('what DND must never silence', () => {
    it('always shows a call banner, because it carries the only Accept button', () => {
      dndEnabled.set(true);
      setAppNotificationPolicy('phone', { banner: false, sound: false, badge: false });

      expect(notificationAllows('banner', { source: 'call', app: 'phone' })).toBe(true);
    });

    it('silences the ringtone under DND but rings for a favourite', () => {
      dndEnabled.set(true);
      expect(notificationAllows('sound', { source: 'call', app: 'phone' })).toBe(false);
      expect(
        notificationAllows('sound', { source: 'call', app: 'phone', breakThrough: true })
      ).toBe(true);
    });

    it('rings a call even when notification sounds are off globally', () => {
      // "Play alert sound on incoming notification" must not silence the phone ringing.
      notificationSoundEnabled.set(false);
      expect(notificationAllows('sound', { source: 'call', app: 'phone' })).toBe(true);
    });

    it('lets a system message through everything', () => {
      // `notifyPlayer` — how moderation and the admin commands reach a player. A warning
      // somebody can mute is one they would never know had been sent.
      dndEnabled.set(true);
      toastsEnabled.set(false);
      notificationSoundEnabled.set(false);
      badgesEnabled.set(false);

      for (const channel of ['banner', 'sound', 'badge'] as const) {
        expect(notificationAllows(channel, { source: 'system' })).toBe(true);
      }
    });
  });

  describe('call break-through', () => {
    it('breaks through for a favourited contact', () => {
      contacts.set([contact('5551234', true)]);
      expect(callBreaksThrough('5551234')).toBe(true);
    });

    it('does not break through for a contact who is merely known', () => {
      contacts.set([contact('5551234', false)]);
      expect(callBreaksThrough('5551234')).toBe(false);
    });

    it('breaks through on a second call inside the window', () => {
      expect(callBreaksThrough('5559999')).toBe(false);
      expect(callBreaksThrough('5559999')).toBe(true);
    });

    it('does not break through once the window has passed', () => {
      vi.useFakeTimers();
      expect(callBreaksThrough('5559999')).toBe(false);
      vi.advanceTimersByTime(REPEAT_CALL_WINDOW_MS + 1);
      expect(callBreaksThrough('5559999')).toBe(false);
    });

    it('counts repeats per number, not globally', () => {
      expect(callBreaksThrough('111')).toBe(false);
      expect(callBreaksThrough('222')).toBe(false);
      expect(callBreaksThrough('111')).toBe(true);
    });
  });

  describe('badge gate used by the launcher surfaces', () => {
    it('follows the global switch and the per-app override', () => {
      expect(badgeAllowedFor('mail')).toBe(true);

      setAppNotificationPolicy('mail', { badge: false });
      expect(badgeAllowedFor('mail')).toBe(false);

      appNotificationPolicies.set({});
      badgesEnabled.set(false);
      expect(badgeAllowedFor('mail')).toBe(false);
    });

    it('answers for an icon with no app id rather than throwing', () => {
      expect(badgeAllowedFor(undefined)).toBe(true);
    });
  });
});
