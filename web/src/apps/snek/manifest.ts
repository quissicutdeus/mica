import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'snek',
  color: 'bg-yellow-500',
  icon: Icon,
  description: 'Retro snake, gPhone style',
  permissions: [],
  author: 'gPhone',
  // Required. `false` makes this an add-on: absent from the launcher, offered by the
  // Store, and uninstallable. Set it to `true` only for something that ships with the
  // phone and must not be removable.
  core: false
});
