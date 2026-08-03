import Icon from './Icon.svelte';
import { defineApp, useNotes } from '@gphone/sdk';

export default defineApp({
  id: 'notes',
  color: 'bg-yellow-400',
  icon: Icon,
  preload: () => useNotes().notesStore.load(),
  description: 'Create and store personal notes',
  permissions: ['storage'],
  author: 'Community',
  isSystem: false
});
