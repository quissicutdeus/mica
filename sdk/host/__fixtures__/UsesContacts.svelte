<script lang="ts">
  import { useContacts } from '../useContacts';
  import type { AppProps } from '../../manifest';

  let {}: AppProps = $props();

  useContacts();
</script>

<div>uses contacts</div>
