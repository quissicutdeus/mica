<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { audio } from '../../shell/state/audio';

  export interface ActionSheetOption {
    id: string;
    label: string;
    style?: 'default' | 'destructive' | 'cancel';
    icon?: any;
    onClick: () => void;
  }

  let {
    title,
    actions = [],
    show = false,
    onclose
  }: {
    title?: string;
    actions: ActionSheetOption[];
    show: boolean;
    onclose: () => void;
  } = $props();

  const handleAction = (action: ActionSheetOption) => {
    audio.play('click');
    action.onClick();
    onclose();
  };
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm"
    transition:fade={{ duration: 150 }}
    onclick={onclose}
    role="presentation"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="animate-in slide-in-from-bottom w-full max-w-sm space-y-2 duration-200"
      transition:fly={{ y: 100, duration: 200 }}
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
    >
      <div
        class="divide-y divide-gray-700/60 overflow-hidden rounded-2xl border border-gray-700/50 bg-gray-800/90 shadow-2xl backdrop-blur-xl"
      >
        {#if title}
          <div
            class="px-4 py-3 text-center text-xs font-semibold tracking-wider text-gray-400 uppercase"
          >
            {title}
          </div>
        {/if}
        {#each actions.filter((a) => a.style !== 'cancel') as action}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center justify-center gap-2 px-4 py-3.5 text-center text-sm font-semibold transition-colors hover:bg-gray-700/50 {action.style ===
            'destructive'
              ? 'text-rose-400 hover:text-rose-300'
              : 'text-blue-400 hover:text-blue-300'}"
            onclick={() => handleAction(action)}
          >
            {#if action.icon}
              {@const IconComp = action.icon}
              <IconComp class="h-4 w-4" />
            {/if}
            <span>{action.label}</span>
          </button>
        {/each}
      </div>

      {#each actions.filter((a) => a.style === 'cancel') as cancelAction}
        <button
          type="button"
          class="w-full cursor-pointer rounded-2xl border border-gray-700/50 bg-gray-800/90 px-4 py-3.5 text-center text-sm font-semibold text-white shadow-xl backdrop-blur-xl transition-colors hover:bg-gray-700"
          onclick={() => handleAction(cancelAction)}
        >
          {cancelAction.label}
        </button>
      {/each}
    </div>
  </div>
{/if}
