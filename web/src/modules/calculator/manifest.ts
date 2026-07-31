import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'calculator',
  name: 'Calculator',
  color: 'bg-gray-800',
  icon: Icon,
  description: 'Perform basic mathematical calculations'
});
