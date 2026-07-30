// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defineApp,
  usePhoneNotification,
  useContacts,
  useCamera,
  useNuiBridge,
  onAppMount,
  onAppUnmount,
  type AppManifest,
} from './index';
import { toast } from '../store/toast';
import { contacts } from '../store/contacts';
import { photos } from '../store/photos';
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

    it('exports MICA_VERSION and MICA_BUILD_INFO constants', () => {
      const { MICA_VERSION, MICA_BUILD_INFO } = require('./index');
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
        avatar: 'TrendingUp',
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
