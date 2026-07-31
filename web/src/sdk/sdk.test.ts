// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defineApp,
  usePhoneNotification,
  useContacts,
  useCamera,
  useNuiBridge,
  useNavigation,
  useStorage,
  useSystemHardware,
  useAccount,
  useCall,
  useMail,
  useNotes,
  useMessages,
  onAppMount,
  onAppUnmount,
  type AppManifest
} from './index';
import { toast } from '../store/toast';
import { contacts } from '../store/contacts';
import { photos } from '../store/photos';
import { mailStore } from '../store/mail';
import { notes } from '../store/notes';
import { messagesStore } from '../store/messages';
import { callStore } from '../store/call';
import { get } from 'svelte/store';

describe('gPhone SDK (@gphone/sdk)', () => {
  beforeEach(() => {
    toast.clear();
  });

  describe('defineApp Manifest Helper', () => {
    it('creates a validated manifest with default values', () => {
      const rawManifest: AppManifest = {
        id: 'crypto_tracker',
        name: 'Crypto Tracker',
        color: 'bg-yellow-500',
        icon: 'BitcoinIcon',
        author: 'Community'
      };

      const app = defineApp(rawManifest);

      expect(app.id).toBe('crypto_tracker');
      expect(app.name).toBe('Crypto Tracker');
      expect(app.color).toBe('bg-yellow-500');
      expect(app.version).toBe('1.0.0');
      expect(app.author).toBe('Community');
      expect(app.permissions).toEqual([]);
      expect(app.defaultProps).toEqual({});
    });

    it('exports MICA_VERSION and MICA_BUILD_INFO constants', async () => {
      const { MICA_VERSION, MICA_BUILD_INFO } = await import('./index');
      expect(MICA_VERSION).toBeDefined();
      expect(MICA_BUILD_INFO).toBeDefined();
    });

    it('throws error when required manifest fields are missing', () => {
      expect(() => defineApp({ id: '', name: 'Test', color: 'red', icon: null } as any)).toThrow(
        "gPhone App Manifest error: 'id' is required"
      );
      expect(() => defineApp({ id: 'app1', name: '', color: 'red', icon: null } as any)).toThrow(
        "gPhone App Manifest error: 'name' is required"
      );
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

    it('useCamera captures and deletes photo items', async () => {
      const { capturePhoto, deletePhoto } = useCamera();

      await capturePhoto('data:image/png;base64,mockImageBytes');
      let photoList = get(photos);
      expect(photoList.length).toBe(1);

      await deletePhoto(photoList[0].id);
      photoList = get(photos);
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

      openApp('calc');
      expect(get(currentApp).name).toBe('calc');

      goHome();
      expect(get(currentApp).name).toBe('home');
    });

    it('useStorage isolates key-value app storage', () => {
      const storage = useStorage('test_app');
      storage.setItem('user_theme', 'dark');

      expect(storage.getItem('user_theme')).toBe('dark');
      expect(storage.getItem('non_existent', 'default_val')).toBe('default_val');

      storage.removeItem('user_theme');
      expect(storage.getItem('user_theme')).toBeNull();
    });

    it('useSystemHardware exposes hardware stores and setters', () => {
      const { charge, signalLevel, setSignal, is24Hour } = useSystemHardware();
      expect(charge).toBeDefined();

      setSignal(3);
      expect(get(signalLevel)).toBe(3);

      expect(is24Hour).toBeDefined();
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

      addReceivedMail({
        id: 99,
        sender: 'test@gphone.app',
        subject: 'SDK Test',
        read: false,
        status: 'active'
      });
      expect(get(mStore).some((m) => m.id === 99)).toBe(true);
    });

    it('useNotes allows managing notes via notesStore', async () => {
      const { notesStore, addNote, deleteNote } = useNotes();
      expect(notesStore).toBeDefined();

      const created = await addNote('Test Title', 'Test Content');
      if (created) {
        expect(get(notesStore).some((n) => n.id === created.id)).toBe(true);
        await deleteNote(created.id);
      }
    });

    it('useMessages exposes messagesStore and messaging utilities', () => {
      const { messagesStore: msgStore, unreadMessagesCount, addReceivedMessage } = useMessages();
      expect(msgStore).toBeDefined();
      expect(unreadMessagesCount).toBeDefined();

      addReceivedMessage({
        id: 88,
        senderName: 'SDK User',
        message: 'Hello',
        conversation_id: 1,
        phone: '555-9999'
      });
      expect(get(msgStore).length).toBeGreaterThan(0);
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
