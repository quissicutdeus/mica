import { fetchCitizenId, fetchBalance } from './account';
import { contacts } from './contacts';
import { messagesStore } from './messages';
import { photos } from './photos';
import { mailStore } from './mail';
import { notes } from './notes';

let isBootstrapped = false;
let bootstrapPromise: Promise<any> | null = null;

/**
 * Preloads primary stores in parallel on phone opening.
 * Ensures switching between apps is instantaneous with zero fetch delays.
 */
export async function bootstrapStores(force: boolean = false): Promise<void> {
  if (isBootstrapped && !force && bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      await Promise.allSettled([
        fetchCitizenId(),
        fetchBalance(),
        contacts.load(),
        messagesStore.loadConversations(),
        photos.load(),
        mailStore.load(),
        notes.load()
      ]);
      isBootstrapped = true;
    } catch (error) {
      console.error('Failed during store bootstrapping:', error);
    }
  })();

  return bootstrapPromise;
}

export function resetBootstrapState(): void {
  isBootstrapped = false;
  bootstrapPromise = null;
}
