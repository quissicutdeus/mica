<script lang="ts">
  import { guarded } from '../guard';
  import type { Host } from '../protocol';

  const {
    hookName,
    appId,
    onResult
  }: {
    hookName: Parameters<typeof guarded>[0];
    appId?: string;
    onResult: (outcome: { host?: Host; error?: unknown }) => void;
  } = $props();

  $effect.pre(() => {
    try {
      const host = guarded(hookName, appId);
      onResult({ host });
    } catch (error) {
      onResult({ error });
    }
  });
</script>

<div>probe</div>
