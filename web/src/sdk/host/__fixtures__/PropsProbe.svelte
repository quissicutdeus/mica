<script lang="ts">
  import type { AppProps } from '../../manifest';

  let { label }: AppProps & { label?: string } = $props();
</script>

<div>{label ?? 'none'}</div>
