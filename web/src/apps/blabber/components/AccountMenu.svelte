<script lang="ts">
  import { Avatar, CheckIcon } from '@gphone/sdk';
  import type { Account } from '@shared/types';

  /**
   * Identity, as a menu dropping from the header avatar that opens it.
   *
   * Three things live here, and two of them had no way in at all before. The server has always
   * allowed `gphone_max_accounts_per_app` identities (three by default) while `ClaimHandle`
   * rendered only when the list was *empty* — so a second handle was unreachable from the phone.
   * `display_name` and `bio` have likewise been client-writable columns with no UI and no route.
   *
   * **Anchored to the top, not risen from the bottom.** It began as a bottom sheet copying
   * `ReportDialog`, the repo's only one, and that was the wrong borrowing: a sheet slides up from
   * the bottom because a phone is tall and a thumb lives down there. gPhone is a mouse-driven
   * overlay inside a game, so that reasoning does not transfer, and a five-item menu opening a
   * full screen-height away from the control that triggered it is only travel. A dialog that
   * needs the player's whole attention — reporting content — still belongs at the bottom.
   *
   * A menu rather than a screen because switching identity is a decision about the screen you are
   * already on, not a place you go. Note `ActionSheet` was written as a shared primitive, imported
   * by nobody, and deleted; if a second app ever wants this it earns a place in `sdk/ui/` then,
   * rather than being kept warm now.
   */
  let {
    accounts,
    activeId,
    canClaim,
    limit,
    onswitch,
    onclaim,
    onedit,
    onclose
  }: {
    accounts: Account[];
    activeId: number | null;
    canClaim: boolean;
    limit: number;
    onswitch: (id: number) => void;
    onclaim: () => void;
    onedit: () => void;
    onclose: () => void;
  } = $props();
</script>

<!-- A sibling rather than a wrapper: a full-bleed `<button>` cannot contain the panel's own
     buttons, and dimming without catching the click leaves a menu only Back can dismiss. -->
<button
  type="button"
  class="bg-scrim animate-in fade-in absolute inset-0 z-40 duration-150"
  aria-label="Close menu"
  onclick={onclose}
></button>

<!-- `top-20` clears the header rather than guessing at it: the header is one row of padding plus a
     40px icon button, so 5rem lands just below with a hairline of gap. -->
<div
  class="animate-in fade-in border-hairline absolute top-20 right-2 z-40 w-56 overflow-hidden rounded-2xl border bg-gray-900 shadow-xl duration-150"
>
  <p class="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
    Posting as · {accounts.length} of {limit}
  </p>

  {#each accounts as account (account.id)}
    {@const active = account.id === activeId}
    <button
      type="button"
      aria-pressed={active}
      class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors {active
        ? 'bg-gray-800 text-white'
        : 'text-gray-300 hover:bg-gray-800'}"
      onclick={() => onswitch(account.id)}
    >
      <Avatar
        initials={account.handle.slice(0, 2).toUpperCase()}
        src={account.avatar ?? ''}
        size="w-7 h-7"
        textClass="text-[10px]"
        showSilhouette={false}
      />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-semibold"
          >{account.display_name || account.handle}</span
        >
        <span class="block truncate text-[11px] text-gray-500">@{account.handle}</span>
      </span>
      {#if active}
        <CheckIcon class="h-4 w-4 shrink-0 text-sky-400" />
      {/if}
    </button>
  {/each}

  <div class="border-t border-gray-800">
    <button
      type="button"
      class="w-full cursor-pointer px-3 py-2.5 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800"
      onclick={onedit}
    >
      Edit profile
    </button>
    {#if canClaim}
      <button
        type="button"
        class="w-full cursor-pointer px-3 py-2.5 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800"
        onclick={onclaim}
      >
        Claim another handle
      </button>
    {/if}
  </div>
</div>
