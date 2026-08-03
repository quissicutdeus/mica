import Icon from './Icon.svelte';
import { defineApp, useNotes } from '@gphone/sdk';

export default defineApp({
  id: 'notes',
  color: 'bg-yellow-400',
  icon: Icon,
  preload: () => useNotes().notesStore.load(),
  description: 'Create and store personal notes',
  permissions: ['storage'],
  // No `author`: it is written in this repo, so it inherits 'gPhone' from defineApp. It
  // claimed 'Community' back when that string was what kept it out of the launcher —
  // `core: false` does that now, and the author is free to be true.
  core: false
});
