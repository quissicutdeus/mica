<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Avatar from './Avatar.svelte';
  import CheckIcon from './icons/CheckIcon.svelte';
  import { focusTrap } from '../lib/focusTrap';
  import { initialsOf } from '../lib/initials';
  import type { AccountMenuAccount, AccountMenuAction } from './accountMenu';

  /**
   * A menu dropping from the header control that opened it (MICA-410): Blabber's and
   * Glimpse's identity switcher and Spark's match menu were three copies of this panel.
   *
   * **Anchored to the top, not risen from the bottom.** A sheet rises from the bottom because
   * a phone is tall and a thumb lives down there; micaOS is a mouse-driven overlay, so a menu
   * opening a screen-height away from its control is only travel. `ReportDialog` still sits
   * at the bottom, because reporting wants the player's whole attention.
   *
   * **A dialog, as `ConfirmDialog` is.** The panel is `role="dialog"` and modal, takes focus
   * when it opens so a screen reader reads its label rather than staying on the avatar that
   * opened it, and traps Tab. `focusTrap` hands focus back to that control on close.
   *
   * **Back is the caller's.** The app keeps the open flag in its `useAppLevels` levels, so
   * Back closes the menu like any other level; there is no key listener here (AGENTS.md §2.7).
   * A tap on the scrim calls `onclose`.
   *
   * Every item is a `<button>`. Strings are the caller's: `label` names the dialog,
   * `closeLabel` the scrim, `heading` the optional caption over the accounts.
   */
  interface Props {
    /** The dialog's accessible name — "Accounts", "Match options". */
    label: string;
    /** The scrim button's name — "Close menu". */
    closeLabel: string;
    /** A caption over the accounts — "Posting as (2 of 3)". */
    heading?: string;
    accounts?: AccountMenuAccount[];
    /** The account drawn as current, with a check and `aria-pressed`. */
    activeId?: string | number | null;
    /** Called with the tapped account's id. Required to draw accounts at all. */
    onswitch?: (id: string | number) => void;
    actions?: AccountMenuAction[];
    onclose: () => void;
    /** A `data-testid` for the panel. */
    testid?: string;
  }

  let {
    label,
    closeLabel,
    heading = undefined,
    accounts = [],
    activeId = null,
    onswitch = undefined,
    actions = [],
    onclose,
    testid = undefined
  }: Props = $props();

  const showAccounts = $derived(accounts.length > 0 && !!onswitch);

  let panel = $state<HTMLElement | null>(null);

  $effect(() => {
    panel?.focus({ preventScroll: true });
  });
</script>

<!-- A sibling rather than a wrapper: a full-bleed `<button>` cannot contain the panel's own
     buttons, and dimming without catching the click leaves a menu only Back can dismiss. -->
<button
  type="button"
  class="bg-scrim animate-in fade-in duration-short ease-standard absolute inset-0 z-40"
  aria-label={closeLabel}
  onclick={onclose}
></button>

<!-- `top-20` clears the header rather than guessing at it: one row of padding plus a 40px
     icon button, so 5rem lands just below with a hairline of gap. -->
<div
  bind:this={panel}
  use:focusTrap
  role="dialog"
  aria-modal="true"
  aria-label={label}
  tabindex="-1"
  class="animate-in fade-in border-outline-variant bg-surface shadow-elevation-4 duration-short ease-standard absolute top-20 right-2 z-40 w-56 overflow-hidden rounded-box border outline-none"
  data-testid={testid}
>
  {#if showAccounts}
    {#if heading}
      <p class="text-on-surface-variant text-label-small px-3 pt-3 pb-1 tracking-wide uppercase">
        {heading}
      </p>
    {/if}

    {#each accounts as account (account.id)}
      {@const active = account.id === activeId}
      <button
        type="button"
        aria-pressed={active}
        class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors {active
          ? 'bg-surface-container text-on-surface'
          : 'text-on-surface hover:bg-surface-container'} duration-short ease-standard"
        onclick={() => onswitch?.(account.id)}
      >
        <Avatar
          initials={initialsOf(account.handle)}
          src={account.avatar ?? ''}
          size="w-7 h-7"
          textClass="text-label-small"
          showSilhouette={false}
        />
        <span class="min-w-0 flex-1">
          <span class="text-body-small block truncate"
            >{account.display_name || account.handle}</span
          >
          <span class="text-on-surface-variant text-label-small block truncate"
            >@{account.handle}</span
          >
        </span>
        {#if active}
          <CheckIcon class="text-primary size-icon-sm shrink-0" />
        {/if}
      </button>
    {/each}
  {/if}

  {#if actions.length > 0}
    <div class={showAccounts ? 'border-outline-variant border-t' : ''}>
      {#each actions as action, index (index)}
        <button
          type="button"
          class="{action.tone === 'danger'
            ? 'text-error'
            : 'text-on-surface'} hover:bg-surface-container duration-short ease-standard text-body-small w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
          onclick={action.onselect}
          data-testid={action.testid}
        >
          {action.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
