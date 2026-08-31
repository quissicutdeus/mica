<script lang="ts">
  import HostProvider from '../../HostProvider.svelte';
  import UsesContacts from './UsesContacts.svelte';
  import type { Host } from '../protocol';

  let { host }: { host: Host } = $props();
</script>

<HostProvider {host}>
  <UsesContacts onback={() => {}} />
</HostProvider>
