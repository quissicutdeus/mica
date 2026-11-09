import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

/**
 * The frozen add-on (MICA-462). Never shipped, never in `apps/`.
 *
 * It declares `contacts` so the template's build, which refuses a hook the manifest does not
 * name, lets the bundle ask for them. The catalog entry beside the bundle (`entry.json`) grants
 * only `notifications`, and that gap is the undeclared call the spec watches the shell refuse.
 */
export default defineApp({
  id: 'frozenprobe',
  name: 'Frozen Probe',
  tile: { bg: 'bg-yellow-400', fg: 'text-gray-900' },
  icon: Icon,
  description: 'A bundle frozen against SDK contract version 1.',
  permissions: ['notifications', 'contacts'],
  author: 'e2e',
  core: false
});
