// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { onMount } from 'svelte';

interface NuiMessageData<T = unknown> {
  action: string;
  data: T;
}

/**
 * Listens for NUI events emitted from FiveM client or browser mock.
 * Automatically cleans up the event listener on component unmount if called in lifecycle,
 * or returns a destroy function for manual cleanup.
 */
export function useNuiEvent<T = unknown>(action: string, handler: (data: T) => void): () => void {
  const eventListener = (event: MessageEvent<NuiMessageData<T>>) => {
    const { action: eventAction, data } = event.data || ({} as Partial<NuiMessageData<T>>);
    if (eventAction === action) {
      handler(data);
    }
  };

  window.addEventListener('message', eventListener);

  const destroy = () => {
    window.removeEventListener('message', eventListener);
  };

  try {
    onMount(() => destroy);
  } catch {
    // Called outside component lifecycle (e.g. in store), manual destroy returned
  }

  return destroy;
}
