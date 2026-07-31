import { writable } from 'svelte/store';
import { fetchNui } from '../utils/fetchNui';

// { name: 'appname', props: {} }
export const currentApp = writable<any>({ name: 'home', props: {} });

export const openApp = (appName: string, props: any = {}) => {
  currentApp.set({ name: appName.toLowerCase(), props });
};

export const goHome = () => {
  currentApp.set({ name: 'home', props: {} });
};

export const closePhone = () => {
  fetchNui('hideFrame');
  goHome();
};
