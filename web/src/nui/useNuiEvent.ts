import { onMount } from 'svelte';

interface NuiMessageData<T = any> {
  action: string;
  data: T;
}

/**
 * Listens for NUI events emitted from FiveM client or browser mock.
 * Automatically cleans up the event listener on component unmount if called in lifecycle,
 * or returns a destroy function for manual cleanup.
 */
export function useNuiEvent<T = any>(action: string, handler: (data: T) => void): () => void {
  const eventListener = (event: MessageEvent<NuiMessageData<T>>) => {
    const { action: eventAction, data } = event.data || {};
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
  } catch (e) {
    // Called outside component lifecycle (e.g. in store), manual destroy returned
  }

  return destroy;
}
