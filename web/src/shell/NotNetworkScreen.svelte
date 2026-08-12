<script lang="ts">
  import { EmptyState, Screen } from '@gphone/sdk';

  let { title, onback }: { title: string; onback: () => void } = $props();
</script>

<Screen {title} {onback}>
  <div class="flex h-full items-center justify-center p-6">
    <EmptyState
      title="No Signal"
      description="This app needs a cellular connection. Reconnect to service to continue."
    />
  </div>
</Screen>
