import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'blabber',
  color: 'bg-sky-500',
  icon: Icon,
  description: 'Post short updates and follow other players',
  author: 'gPhone',
  // An add-on: absent from the launcher until installed from the Store. The first real
  // non-core app, and the first genuine listing the Store has ever had.
  core: false,
  permissions: ['notifications', 'media', 'storage']
});
