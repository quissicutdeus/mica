import { fetchCitizenId, fetchBalance } from '../../services/account';
import { contacts } from '../../services/contacts';
import { conversationsStore } from '../../services/conversations';
import { photos } from '../../services/photos';
import { mailStore } from '../../services/mail';
import { notes } from '../../services/notes';
import { refreshAdmin } from '../../services/admin';
import { loadPendingReports } from '../../services/reports';

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
        // Asked here so the home screen knows whether to draw the Administration app
        // before it renders, rather than having it appear a beat later.
        refreshAdmin(),
        // So the Administration badge is right before the launcher draws.
        loadPendingReports(),
        fetchCitizenId(),
        fetchBalance(),
        contacts.load(),
        conversationsStore.loadConversations(),
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
