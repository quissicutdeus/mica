<script lang="ts">
  import {
    AddIcon,
    Button,
    ConfirmDialog,
    EmptyState,
    ListItem,
    Screen,
    Skeleton,
    TrashIcon,
    onAppForeground,
    useAppAction,
    useAppLevels,
    type AppProps
  } from '@gphone/sdk';
  import { useCryptoTracker } from './store';

  // The annotation, not `$props<AppProps>()` — that form only works for an inline object
  // literal and reports "Expected 0 type arguments" for a named type.
  let { onback }: AppProps = $props();

  const { cryptoTracker, addHolding, deleteHolding } = useCryptoTracker();
  const loaded = cryptoTracker.loaded;
  const { busy, run } = useAppAction('crypto_tracker');

  let isAdding = $state(false);
  let pendingDeleteId: number | null = $state(null);
  let symbol = $state('');
  let amount = $state('');

  // Every visit, not once per session — apps stay resident (AGENTS.md §11).
  onAppForeground('crypto_tracker', () => {
    void cryptoTracker.load();
  });

  // Declaring the levels is what claims the Back key. Add a rung per screen, deepest
  // first; with none, Back simply leaves the app. `appId` is what keeps the claim
  // pointed at this app while it sits resident in the background.
  const app = useAppLevels({
    appId: 'crypto_tracker',
    title: 'Crypto Tracker',
    onback: () => onback(),
    levels: [
      {
        open: () => pendingDeleteId !== null,
        close: () => (pendingDeleteId = null)
      },
      {
        open: () => isAdding,
        close: () => (isAdding = false),
        title: 'Add Holding'
      }
    ]
  });

  const submit = async () => {
    if (!(await run(() => addHolding(symbol.trim().toUpperCase(), amount.trim())))) return;
    isAdding = false;
    symbol = '';
    amount = '';
  };

  const confirmDelete = async () => {
    if (pendingDeleteId === null) return;
    await run(() => deleteHolding(pendingDeleteId!));
    pendingDeleteId = null;
  };
</script>

{#snippet headerActions()}
  {#if !isAdding}
    <button
      class="hover:bg-surface-container-high duration-short ease-standard ml-auto rounded-full p-2 transition-colors"
      onclick={() => (isAdding = true)}
      aria-label="Add holding"
    >
      <AddIcon />
    </button>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions}>
  {#if isAdding}
    <div class="flex flex-col gap-3 p-4">
      <input
        class="bg-surface-container-high placeholder-on-surface-variant w-full rounded p-3 uppercase"
        placeholder="Symbol (e.g. BTC)"
        bind:value={symbol}
        maxlength="10"
        disabled={$busy}
      />
      <input
        class="bg-surface-container-high placeholder-on-surface-variant w-full rounded p-3"
        placeholder="Amount held"
        inputmode="decimal"
        bind:value={amount}
        disabled={$busy}
      />
      <div class="flex gap-2">
        <Button
          class="flex-1"
          variant="secondary"
          onclick={() => (isAdding = false)}
          disabled={$busy}
        >
          Cancel
        </Button>
        <Button class="flex-1" onclick={submit} disabled={$busy}>
          {$busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  {:else}
    <div class="p-4">
      {#if !$loaded}
        <Skeleton count={4} height="h-14" />
      {:else if $cryptoTracker.length === 0}
        <EmptyState title="No holdings yet" description="Tap + to add the coins you're tracking." />
      {:else}
        {#each $cryptoTracker as holding (holding.id)}
          <ListItem
            class="bg-surface-container mb-2 rounded-lg p-4"
            onclick={() => (pendingDeleteId = holding.id)}
          >
            <div class="flex w-full items-center justify-between">
              <div>
                <p class="text-on-surface font-bold">{holding.symbol}</p>
                <p class="text-on-surface-variant text-body-medium">{holding.amount}</p>
              </div>
              <TrashIcon class="text-error h-5 w-5" />
            </div>
          </ListItem>
        {/each}
      {/if}
    </div>
  {/if}

  {#if pendingDeleteId !== null}
    <ConfirmDialog
      title="Delete Holding?"
      message="This removes it from your tracker. This action cannot be undone."
      confirmText="Delete"
      isLoading={$busy}
      oncancel={() => (pendingDeleteId = null)}
      onconfirm={confirmDelete}
    />
  {/if}
</Screen>
