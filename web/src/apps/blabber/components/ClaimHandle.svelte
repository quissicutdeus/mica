<script lang="ts">
  import { Button } from '@gphone/sdk';

  /**
   * `oncancel` is optional, and its absence is the point.
   *
   * This screen is two things. As the **gate**, shown when the player holds no account at all,
   * there is nothing behind it to go back to — the feed needs an identity to post from, so a
   * Cancel there would dismiss the only thing on screen and leave the app empty. As the **claim
   * another handle** overlay it is reached from the identity menu, so it must be leaveable: it is
   * `inset-0` like every other overlay here and therefore paints over the header, so without this
   * the only way out was the Backspace keybind and there was no on-screen way at all.
   *
   * Same shape as `Composer`'s `oncancel`, for the same reason: one component, one caller that
   * can be backed out of and one that cannot.
   */
  let {
    busy = false,
    onclaim,
    oncancel
  }: { busy?: boolean; onclaim: (handle: string) => void; oncancel?: () => void } = $props();

  let handle = $state('');

  /** Mirrors `HANDLE_PATTERN` on the server. The server is the boundary; this is the courtesy. */
  const valid = $derived(/^[a-z0-9_]{3,32}$/.test(handle));
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
  <h2 class="text-on-surface text-lg font-bold">Pick a handle</h2>
  <p class="text-on-surface-variant text-xs">
    This is how people find you. Lowercase letters, numbers and underscores, 3–32 characters.
  </p>

  <div class="bg-surface-container flex w-full items-center gap-1 rounded-lg px-3">
    <span class="text-on-surface-variant text-sm">@</span>
    <input
      bind:value={handle}
      maxlength="32"
      placeholder="handle"
      autocapitalize="none"
      class="text-on-surface placeholder-on-surface-variant w-full bg-transparent py-2.5 text-sm focus:outline-none"
      oninput={() => (handle = handle.toLowerCase())}
    />
  </div>

  <div class="flex w-full gap-2">
    {#if oncancel}
      <Button variant="secondary" class="flex-1" disabled={busy} onclick={oncancel}>Cancel</Button>
    {/if}
    <Button disabled={!valid || busy} class="flex-1" onclick={() => onclaim(handle)}>
      {busy ? '…' : 'Claim'}
    </Button>
  </div>
</div>
