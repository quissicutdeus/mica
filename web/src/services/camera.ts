import { writable } from 'svelte/store';

export const isTakingPhoto = writable(false);
export const isPreviewingPhoto = writable(false);
