import Icon from './Icon.svelte';
import { defineApp } from '@mica/sdk/app';

/** The e2e fixture add-on for the dev loop (MICA-311). Never shipped, never in `apps/`. */
export default defineApp({
  id: 'devprobe',
  name: 'Dev Probe',
  tile: { bg: 'bg-yellow-400', fg: 'text-gray-900' },
  icon: Icon,
  description: 'Fixture for web/e2e/dev-addon.spec.ts.',
  permissions: ['app-events'],
  author: 'e2e',
  core: false
});
