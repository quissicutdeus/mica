import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: 'crypto_tracker',
  name: 'Hodlr',
  color: 'bg-emerald-600',
  icon: Icon,
  // Imported lazily, not at module scope — see `apps/notes/manifest.ts` for why.
  preload: () => import('./store').then((m) => m.cryptoTracker.load()),
  description: 'Track the crypto you hold',
  permissions: [],
  core: false
});
