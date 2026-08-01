<script lang="ts">
  import { useKeybinds, usePhoneNotification } from '@gphone/sdk';

  const { bindings, actions, setBinding, resetBindings, findConflict } = useKeybinds();
  const { toast } = usePhoneNotification();

  /** The action currently waiting for a key, if any. */
  let capturingId = $state<string | null>(null);

  /** `' '` renders as nothing at all, and a bare letter reads better capitalised. */
  const describeKey = (key: string) => {
    if (key === ' ') return 'Space';
    return key.length === 1 ? key.toUpperCase() : key;
  };

  /**
   * Read the next keypress as the new binding.
   *
   * Bound on the window while capturing, in the capture phase, so the press is claimed
   * before the shell dispatcher can act on the *old* binding — otherwise rebinding
   * `back` would navigate away the moment you pressed Escape.
   */
  const captureKey = (event: KeyboardEvent) => {
    if (!capturingId) return;
    event.preventDefault();
    event.stopPropagation();

    // Escape cancels, except when Escape is the thing being rebound.
    if (event.key === 'Escape' && capturingId !== 'back') {
      capturingId = null;
      return;
    }

    // Modifiers alone are legitimate bindings (freelook is Alt), so there is nothing to
    // filter out here beyond the empty case.
    const key = event.key;
    if (!key) return;

    const conflict = findConflict(capturingId, key);
    if (conflict) {
      toast.show({ type: 'error', message: `${describeKey(key)} is already ${conflict.label}` });
      capturingId = null;
      return;
    }

    setBinding(capturingId, key);
    capturingId = null;
  };

  $effect(() => {
    if (!capturingId) return;
    window.addEventListener('keydown', captureKey, true);
    return () => window.removeEventListener('keydown', captureKey, true);
  });
</script>

<div class="p-4">
  <h2
    class="mb-2 flex items-center justify-between px-2 text-sm font-medium tracking-wider text-gray-400 uppercase"
  >
    <span>Shortcuts</span>
    <button
      type="button"
      onclick={resetBindings}
      class="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-gray-500 normal-case transition-colors hover:text-gray-300"
    >
      Reset to defaults
    </button>
  </h2>
  <!-- Only in-phone keys live here. Opening the phone is a FiveM key mapping, so it is
       rebound in the game's own Key Bindings menu — while the phone is open the game
       receives no control input, and a mapping could never fire. -->
  <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
    {#each actions as action (action.id)}
      <button
        type="button"
        data-testid="shortcut-{action.id}"
        onclick={() => (capturingId = action.id)}
        class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40"
      >
        <span class="font-medium text-gray-300">{action.label}</span>
        {#if capturingId === action.id}
          <span
            class="animate-pulse rounded border border-indigo-600 bg-indigo-950 px-2 py-0.5 font-mono text-xs text-indigo-300"
          >
            Press a key…
          </span>
        {:else}
          <span class="rounded bg-gray-900 px-2 py-0.5 font-mono text-xs text-gray-200">
            {describeKey($bindings[action.id])}
          </span>
        {/if}
      </button>
    {/each}
  </div>
  <p class="mt-2 px-2 text-xs text-gray-500">
    Open Phone is bound in FiveM's own Key Bindings menu.
  </p>
</div>
