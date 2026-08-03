<script lang="ts">
  import { Button } from '@gphone/sdk';

  let { busy = false, onclaim }: { busy?: boolean; onclaim: (handle: string) => void } = $props();

  let handle = $state('');

  /** Mirrors `HANDLE_PATTERN` on the server. The server is the boundary; this is the courtesy. */
  const valid = $derived(/^[a-z0-9_]{3,32}$/.test(handle));
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
  <h2 class="text-lg font-bold text-white">Pick a handle</h2>
  <p class="text-xs text-gray-400">
    This is how people find you. Lowercase letters, numbers and underscores, 3–32 characters.
  </p>

  <div class="flex w-full items-center gap-1 rounded-lg bg-gray-800 px-3">
    <span class="text-sm text-gray-500">@</span>
    <input
      bind:value={handle}
      maxlength="32"
      placeholder="handle"
      autocapitalize="none"
      class="w-full bg-transparent py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none"
      oninput={() => (handle = handle.toLowerCase())}
    />
  </div>

  <Button disabled={!valid || busy} class="w-full" onclick={() => onclaim(handle)}>
    {busy ? '…' : 'Claim'}
  </Button>
</div>
