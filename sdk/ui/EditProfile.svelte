<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import { focusTrap } from '../lib/focusTrap';
  import { t } from '../i18n';
  import './messages';

  /**
   * The editable half of a social identity (MICA-416), once: Blabber and Glimpse each drew
   * this panel word for word.
   *
   * `handle` is shown and not editable, and that is a server rule rather than a layout choice:
   * renaming it would silently break every mention already posted, so the accounts table keeps
   * it out of what a client may write.
   *
   * **No avatar picker yet, deliberately.** The avatar column holds a short reference while the
   * gallery hands back image data, so wiring one up produces a value the write path refuses.
   *
   * **A dialog, as `ConfirmDialog` is.** The panel covers the whole app, so it is modal, named
   * by its title, focused on open and traps Tab; `focusTrap` hands focus back to whatever
   * opened it. Back is the caller's, through its `useAppLevels` levels — no key listener here.
   *
   * `maxlength` mirrors each column so a field cannot accept what the write path would refuse.
   * The account is read once, at mount: tracking it would let a store refresh overwrite what
   * the player is halfway through typing.
   */
  interface Props {
    /** The identity being edited. A `shared/types` `Account` passes as it is. */
    account: { handle: string; display_name?: string | null; bio?: string | null };
    busy?: boolean;
    /** Each field trimmed; an emptied one is `null`, a cleared column, not `''`. */
    onsave: (patch: { display_name: string | null; bio: string | null }) => void;
    oncancel: () => void;
    /** The heading and the dialog's name. "Edit profile" in the phone's language by default. */
    title?: string;
  }

  let { account, busy = false, onsave, oncancel, title = undefined }: Props = $props();

  const heading = $derived(title ?? $t('ui.editProfile'));
  const ids = $props.id();

  let displayName = $state(untrack(() => account.display_name ?? ''));
  let bio = $state(untrack(() => account.bio ?? ''));

  const dirty = $derived(
    displayName !== (account.display_name ?? '') || bio !== (account.bio ?? '')
  );

  const save = () => onsave({ display_name: displayName.trim() || null, bio: bio.trim() || null });

  let panel = $state<HTMLElement | null>(null);

  $effect(() => {
    panel?.focus({ preventScroll: true });
  });
</script>

<div
  bind:this={panel}
  use:focusTrap
  role="dialog"
  aria-modal="true"
  aria-label={heading}
  tabindex="-1"
  class="pt-safe-top animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col p-5 outline-none"
>
  <h2 class="text-on-surface mb-1 text-lg font-bold">{heading}</h2>
  <p class="text-on-surface-variant text-body-small mb-4">
    {$t('ui.handleFixed', { handle: account.handle })}
  </p>

  <label class="text-on-surface-variant text-body-small mb-1 block" for="{ids}-display-name">
    {$t('ui.displayName')}
  </label>
  <input
    id="{ids}-display-name"
    bind:value={displayName}
    maxlength="50"
    placeholder={account.handle}
    class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium mb-4 w-full rounded-box px-3 py-2.5 focus:outline-none"
  />

  <label class="text-on-surface-variant text-body-small mb-1 block" for="{ids}-bio"
    >{$t('ui.bio')}</label
  >
  <textarea
    id="{ids}-bio"
    bind:value={bio}
    maxlength="160"
    rows="3"
    placeholder={$t('ui.bioPlaceholder')}
    class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full resize-none rounded-box p-2.5 focus:outline-none"
  ></textarea>
  <span class="text-on-surface-variant text-body-small mt-1 mb-4 text-right"
    >{160 - bio.length}</span
  >

  <div class="flex gap-2">
    <Button class="flex-1" variant="secondary" onclick={oncancel} disabled={busy}
      >{$t('ui.cancel')}</Button
    >
    <Button class="flex-1" disabled={!dirty || busy} onclick={save}>
      {busy ? '…' : $t('ui.save')}
    </Button>
  </div>
</div>
