// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defineApp,
  usePhoneNotification,
  useContacts,
  useMedia,
  useNavigation,
  useStorage,
  useSystemHardware,
  useSystemHardwareWrite,
  useClock,
  useAccount,
  useCall,
  useMail,
  useMessages,
  useNotifications,
  onAppMount,
  onAppUnmount,
  MICA_VERSION
} from './index';
import { useNuiBridge } from './core';
import { toast } from '../web/src/shell/state/toast';
import { contacts } from '../web/src/services/contacts';
import { media } from '../web/src/services/media';
import { get } from 'svelte/store';

describe('gPhone SDK (@gphone/sdk)', () => {
  beforeEach(() => {
    toast.clear();
  });

  describe('defineApp Manifest Helper', () => {
    it('creates a validated manifest with default values', () => {
      const app = defineApp({
        id: 'crypto_tracker',
        name: 'Crypto Tracker',
        tile: { bg: 'bg-yellow-500' },
        icon: 'BitcoinIcon',
        author: 'Community',
        core: false
      });

      expect(app.id).toBe('crypto_tracker');
      expect(app.name).toBe('Crypto Tracker');
      expect(app.tile).toEqual({ bg: 'bg-yellow-500' });
      // Derived, so every consumer that interpolates one class string keeps working.
      expect(app.color).toBe('bg-yellow-500');
      expect(app.version).toBe(MICA_VERSION);
      expect(app.author).toBe('Community');
      expect(app.permissions).toEqual([]);
      expect(app.defaultProps).toEqual({});
    });

    it('exports MICA_VERSION and MICA_BUILD_INFO constants', async () => {
      const { MICA_VERSION, MICA_BUILD_INFO } = await import('./index');
      expect(MICA_VERSION).toBeDefined();
      expect(MICA_BUILD_INFO).toBeDefined();
    });

    it('throws when id is missing, or name is present and empty', () => {
      expect(() => defineApp({ id: '', name: 'Test', color: 'red', icon: null } as any)).toThrow(
        "gPhone App Manifest error: 'id' is required"
      );
      // `name` is optional now and derived from the id when absent — but an empty string is
      // a supplied value rather than an omission, and there is nothing to derive from it.
      expect(() => defineApp({ id: 'app1', name: '', color: 'red', icon: null } as any)).toThrow(
        "gPhone App Manifest error: 'name' must be a non-empty string"
      );
    });

    /**
     * MICA-91. The tile used to be one free-form string holding two roles positionally,
     * and the only thing standing behind it was a DEV-only `console.warn` about hex values
     * — a warning in a browser console, for a tile that renders invisible.
     */
    describe('the launcher tile', () => {
      const base = { id: 'probe', icon: null, core: false } as const;

      it('refuses a background that is not a utility class', () => {
        expect(() => defineApp({ ...base, tile: { bg: '#4ade80' } })).toThrow(
          "tile.bg '#4ade80', which is not a single 'bg-' utility class"
        );
        expect(() => defineApp({ ...base, tile: { bg: 'green' } })).toThrow("tile.bg 'green'");
        // Two classes in one field is the shape the structured tile exists to prevent.
        expect(() => defineApp({ ...base, tile: { bg: 'bg-a bg-b' } })).toThrow('tile.bg');
      });

      it('refuses a foreground that is not a text class', () => {
        expect(() =>
          defineApp({ ...base, tile: { bg: 'bg-yellow-400', fg: 'bg-gray-900' } })
        ).toThrow("tile.fg 'bg-gray-900', which is not a single 'text-' utility class");
      });

      it('refuses a manifest with no tile at all', () => {
        expect(() => defineApp({ ...base })).toThrow("'probe' must declare 'tile'");
      });

      it('still accepts the legacy `color` string, and splits it into roles', () => {
        // An add-on bundle published before `tile` existed has to keep loading.
        const app = defineApp({ ...base, color: 'bg-green-400 text-gray-900' });
        expect(app.tile).toEqual({ bg: 'bg-green-400', fg: 'text-gray-900' });
        expect(app.color).toBe('bg-green-400 text-gray-900');
      });

      it('reads the roles by name, not by position', () => {
        const app = defineApp({ ...base, color: 'text-gray-900 bg-green-400' });
        expect(app.tile).toEqual({ bg: 'bg-green-400', fg: 'text-gray-900' });
        // Normalised on the way out: background first, however it was written.
        expect(app.color).toBe('bg-green-400 text-gray-900');
      });

      it('refuses both spellings when they disagree, rather than picking a winner', () => {
        expect(() =>
          defineApp({ ...base, tile: { bg: 'bg-sky-500' }, color: 'bg-rose-600' })
        ).toThrow("declares both 'tile' and 'color', and they disagree");
      });

      it('is idempotent, because the registry re-runs it over its own output', () => {
        // `shell/state/registry.ts` calls `defineApp` again on every already-defined
        // manifest to stamp `installedAt`, so the second pass sees the `color` the first
        // one derived. Refusing both outright failed every app in the repo at boot.
        const once = defineApp({ ...base, tile: { bg: 'bg-green-400', fg: 'text-gray-900' } });
        const twice = defineApp(once);
        expect(twice.tile).toEqual(once.tile);
        expect(twice.color).toBe(once.color);
      });

      it('refuses a legacy color naming no background', () => {
        expect(() => defineApp({ ...base, color: '#f59e0b' })).toThrow(
          "color '#f59e0b', which names no 'bg-' utility class"
        );
      });
    });
  });

  describe('OS Service Hooks', () => {
    it('usePhoneNotification triggers toast notification', () => {
      const { sendNotification, dismissNotification } = usePhoneNotification();

      const notificationId = sendNotification({
        title: 'Crypto Alert',
        message: 'Bitcoin reached $100k',
        avatar: 'TrendingUp'
      });

      const toasts = get(toast);
      expect(toasts.length).toBe(1);
      expect(toasts[0].title).toBe('Crypto Alert');
      expect(toasts[0].message).toBe('Bitcoin reached $100k');

      dismissNotification(notificationId);
      expect(get(toast).length).toBe(0);
    });

    it('useContacts allows searching and adding contacts', async () => {
      const { addContact } = useContacts();

      const newContact = await addContact('Alice', '555-0100', 'Smith');
      expect(newContact).toBeDefined();

      const contactList = get(contacts);
      expect(contactList.length).toBe(1);
      expect(contactList[0].firstname).toBe('Alice');
      expect(contactList[0].phone).toBe('555-0100');
    });

    it('useMedia captures and deletes photo items', async () => {
      const { capturePhoto, deletePhoto } = useMedia();

      await capturePhoto('data:image/png;base64,mockImageBytes');
      let photoList = get(media);
      expect(photoList.length).toBe(1);

      await deletePhoto(photoList[0].id);
      photoList = get(media);
      expect(photoList.length).toBe(0);
    });

    it('useNuiBridge exposes fetchNui and useNuiEvent', () => {
      const { fetchNui, useNuiEvent } = useNuiBridge();
      expect(fetchNui).toBeTypeOf('function');
      expect(useNuiEvent).toBeTypeOf('function');
    });

    it('useNavigation exposes navigation controls', () => {
      const { openApp, goHome, currentApp } = useNavigation();
      expect(openApp).toBeTypeOf('function');
      expect(goHome).toBeTypeOf('function');

      // A real id: `openApp` refuses one with no component, so `calc` (the app is
      // `calculator`) would be a no-op and the assertion would be testing nothing.
      openApp('calculator');
      expect(get(currentApp).id).toBe('calculator');

      goHome();
      expect(get(currentApp).id).toBe('home');
    });

    it('useStorage isolates key-value app storage', () => {
      const storage = useStorage('test_app');
      storage.setItem('user_theme', 'dark');

      expect(storage.getItem('user_theme')).toBe('dark');
      expect(storage.getItem('non_existent', 'default_val')).toBe('default_val');

      storage.removeItem('user_theme');
      expect(storage.getItem('user_theme')).toBeNull();
    });

    it('useSystemHardware exposes hardware stores, and useSystemHardwareWrite sets them', () => {
      const { charge, signalLevel } = useSystemHardware();
      const { setSignal } = useSystemHardwareWrite();
      expect(charge).toBeDefined();

      setSignal(3);
      expect(get(signalLevel)).toBe(3);
    });

    it('useClock exposes the time and its format', () => {
      // Split out of useSystemHardware: a 12/24-hour preference is a locale setting,
      // not hardware.
      const { time, is24Hour } = useClock();
      expect(time).toBeDefined();

      is24Hour.set(true);
      expect(get(is24Hour)).toBe(true);
    });

    it('useAccount exposes bankBalance, transactions, citizenid, and phone number', () => {
      const { bankBalance, transactions, citizenid, myPhoneNumber } = useAccount();
      expect(bankBalance).toBeDefined();
      expect(transactions).toBeDefined();
      expect(citizenid).toBeDefined();
      expect(get(myPhoneNumber)).toBe('555-0199');
    });

    it('useCall exposes callStore and call controls', () => {
      const { callStore: cStore, startCall, endCall } = useCall();
      expect(cStore).toBeDefined();
      expect(startCall).toBeTypeOf('function');
      expect(endCall).toBeTypeOf('function');
    });

    it('useMail exposes mailStore and unread mail count', () => {
      const { mailStore: mStore, unreadMailCount, addReceivedMail } = useMail();
      expect(mStore).toBeDefined();
      expect(unreadMailCount).toBeDefined();

      // A whole Mail, because that is what the hook takes. It was missing citizenid,
      // content and both timestamps, and `any` let it through.
      const now = new Date().toISOString();
      addReceivedMail({
        id: 99,
        citizenid: 'CIT_TEST',
        sender: 'test@gphone.app',
        subject: 'SDK Test',
        content: 'Body',
        read: false,
        status: 'active',
        created_at: now,
        updated_at: now
      });
      expect(get(mStore).some((m) => m.id === 99)).toBe(true);
    });

    it('useMessages exposes conversationsStore and messaging utilities', () => {
      const {
        conversationsStore: msgStore,
        unreadMessagesCount,
        addReceivedMessage
      } = useMessages();
      expect(msgStore).toBeDefined();
      expect(unreadMessagesCount).toBeDefined();

      // No `id`: an inbound message is identified by its conversation, and the store
      // assigns one. Passing a stray `id` did nothing and only looked like it did.
      addReceivedMessage({
        senderName: 'SDK User',
        message: 'Hello',
        conversation_id: 1,
        phone: '555-9999'
      });
      expect(get(msgStore).length).toBeGreaterThan(0);
    });

    it('useMessages.startText opens Messages with a bare phone number, no Contact required', () => {
      const { startText } = useMessages();
      const { currentApp } = useNavigation();

      startText('555-0100');

      expect(get(currentApp).id).toBe('messages');
      expect(get(currentApp).props).toEqual({ phone: '555-0100', startNew: true });
    });

    it('useNotifications provides notification stores and management methods', () => {
      const { notificationsStore, unreadCount, markRead, clear, clearAll } =
        useNotifications('blabber');

      expect(notificationsStore).toBeDefined();
      expect(unreadCount).toBeDefined();
      expect(typeof markRead).toBe('function');
      expect(typeof clear).toBe('function');
      expect(typeof clearAll).toBe('function');
    });
  });

  describe('Lifecycle Wrappers', () => {
    it('onAppMount executes callback gracefully', () => {
      const mountSpy = vi.fn();
      onAppMount(mountSpy);
      expect(mountSpy).toHaveBeenCalled();
    });

    it('onAppUnmount executes without throwing outside svelte component', () => {
      const unmountSpy = vi.fn();
      expect(() => onAppUnmount(unmountSpy)).not.toThrow();
    });
  });
});
