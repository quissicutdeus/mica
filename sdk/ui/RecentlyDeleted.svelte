<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Button from './Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import TrashIcon from './icons/TrashIcon.svelte';
  import { formatRelativeTime } from '../lib/formatters';
  import { t } from '../i18n';
  import './messages';
  import type { RecentlyDeletedItem } from './recentlyDeleted';

  /**
   * The Contacts/Notes/Media "Recently Deleted" screen, once (MICA-75).
   *
   * All three moved a `status` column to `'deleted'` instead of removing the row, entirely
   * for moderation's sake — but nobody ever read that status back for the person who set it,
   * so deleting felt permanent from the player's side even though the row was sitting right
   * there. This is restore-only, on purpose: soft-deleted rows stay soft-deleted forever by
   * default (a retention convar for an automatic hard-delete is a server-side follow-up, not
   * this component's concern), so there is no countdown or "expires in" copy to get wrong.
   *
   * `onrestore` and `onpermanentdelete` are both handed a bare id — this component holds no
   * opinion about what a restore or a permanent delete actually does server-side, only about
   * presenting the list and getting confirmation before the irreversible one. It owns that
   * confirmation itself (via `ConfirmDialog`) rather than leaving each app to remember to ask,
   * which is exactly the kind of divergence three independent copies of this screen would
   * have produced — one of them shipping with no confirmation at all.
   *
   * Restore fires immediately: it is not destructive, and a confirm step on the safe path
   * only trains players to click through confirms without reading them.
   */
  interface Props {
    items: RecentlyDeletedItem[];
    onrestore: (id: string | number) => void;
    /**
     * Optional (MICA-75-wiring): the server side of this ticket ships no hard-delete
     * this round — soft-deleted stays soft-deleted forever, a row past any future
     * retention window just stops appearing in `restore`'s results rather than being
     * purged. A caller with nothing real to wire this to omits it and gets a restore-only
     * list, rather than a delete-forever button that lies about what it does. Contacts,
     * Notes and Media all omit it today.
     */
    onpermanentdelete?: (id: string | number) => void;
    emptyTitle?: string;
    emptyDescription?: string;
  }

  let {
    items,
    onrestore,
    onpermanentdelete,
    emptyTitle = undefined,
    emptyDescription = undefined
  }: Props = $props();

  // `$derived` fallbacks rather than prop defaults: a default is evaluated once and could
  // not follow the locale. Both stay optional props, so a caller with its own words is
  // unaffected.
  const emptyHeading = $derived(emptyTitle ?? $t('ui.nothingHere'));
  const emptyHint = $derived(emptyDescription ?? $t('ui.nothingHereHint'));

  let pending = $state<RecentlyDeletedItem | null>(null);

  const asDate = (value: string | number | Date) =>
    value instanceof Date ? value : new Date(value);

  const confirmDelete = () => {
    if (!pending || !onpermanentdelete) return;
    onpermanentdelete(pending.id);
    pending = null;
  };
</script>

{#if items.length === 0}
  <EmptyState title={emptyHeading} description={emptyHint} />
{:else}
  <div class="divide-outline-variant divide-y">
    {#each items as item (item.id)}
      <div class="flex items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="text-on-surface text-body-medium truncate font-medium">{item.label}</p>
          {#if item.preview}
            <p class="text-on-surface-variant text-body-small truncate">{item.preview}</p>
          {/if}
          <p class="text-on-surface-variant text-label-small mt-0.5">
            {$t('ui.deletedAt', { when: formatRelativeTime(asDate(item.deletedAt)) })}
          </p>
        </div>
        <Button variant="secondary" class="shrink-0" onclick={() => onrestore(item.id)}>
          {$t('ui.restore')}
        </Button>
        {#if onpermanentdelete}
          <button
            type="button"
            onclick={() => (pending = item)}
            aria-label={$t('ui.deleteNamedPermanently', { label: item.label })}
            title={$t('ui.deletePermanently')}
            class="text-on-surface-variant hover:text-error hover:bg-error-container focus-visible:ring-focus-ring flex shrink-0 cursor-pointer items-center justify-center rounded-full p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none duration-short ease-standard"
          >
            <TrashIcon class="size-icon-md" />
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if pending}
  <ConfirmDialog
    title={$t('ui.deletePermanentlyTitle')}
    message={$t('ui.deletePermanentlyMessage', { label: pending.label })}
    confirmText={$t('ui.delete')}
    confirmVariant="danger"
    onconfirm={confirmDelete}
    oncancel={() => (pending = null)}
  />
{/if}
