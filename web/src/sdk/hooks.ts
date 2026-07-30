import { onMount, onDestroy } from "svelte";
import { toast, type ToastMessage } from "../store/toast";
import { contacts } from "../store/contacts";
import { photos } from "../store/photos";
import { fetchNui } from "../utils/fetchNui";
import { useNuiEvent } from "../utils/useNuiEvent";

import { appRegistryStore } from "../store/registry";
import type { AppManifest } from "./manifest";

/**
 * Executes a callback when the application component mounts into the gPhone shell.
 */
export function onAppMount(handler: () => void): void {
  try {
    onMount(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
    handler();
  }
}

/**
 * Executes a cleanup callback when the application component is unmounted or closed.
 */
export function onAppUnmount(handler: () => void): void {
  try {
    onDestroy(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
  }
}

export interface SendNotificationOptions {
  title?: string;
  message: string;
  avatar?: string;
  type?: ToastMessage["type"];
  duration?: number;
  onClick?: () => void;
}

/**
 * OS Service Hook for sending toast notifications and system alerts.
 */
export function usePhoneNotification() {
  return {
    sendNotification: (options: SendNotificationOptions) => {
      return toast.show({
        title: options.title,
        message: options.message,
        avatar: options.avatar,
        type: options.type || "info",
        duration: options.duration,
        onClick: options.onClick,
      });
    },
    dismissNotification: (id: string) => {
      toast.dismiss(id);
    },
    toast,
  };
}

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function useContacts() {
  return {
    contactsStore: contacts,
    addContact: (firstname: string, phone: string, lastname?: string, avatar?: string, favorite?: boolean) => {
      return contacts.add({ firstname, lastname: lastname || "", phone, avatar, favorite: favorite ?? false });
    },
    shareContact: (firstname: string, phone: string, lastname?: string) => {
      return contacts.share({ firstname, lastname: lastname || "", phone });
    },
  };
}

/**
 * OS Service Hook for accessing camera and photo gallery.
 */
export function useCamera() {
  return {
    photosStore: photos,
    capturePhoto: async (image: string) => {
      return photos.add({ image });
    },
    deletePhoto: async (id: number) => {
      return photos.delete(id);
    },
  };
}

/**
 * OS Service Hook for FiveM NUI transport bridge events.
 */
export function useNuiBridge() {
  return {
    fetchNui,
    useNuiEvent,
  };
}

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 */
export function useAppRegistry() {
  return {
    registryStore: appRegistryStore,
    loadRemoteApp: (url: string) => appRegistryStore.loadRemoteApp(url),
    registerApp: (manifest: AppManifest, component: any) => appRegistryStore.registerApp(manifest, component),
    unregisterApp: (appId: string) => appRegistryStore.unregisterApp(appId),
  };
}

