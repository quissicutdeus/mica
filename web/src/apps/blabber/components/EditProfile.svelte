<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, useLocale } from '@gphone/sdk';
  import type { Account } from '@gphone/shared/types';

  /**
   * The editable half of an identity.
   *
   * `handle` is shown and not editable, and that is a server rule rather than a layout choice:
   * it is `clientWritable: false` because renaming it would silently break every mention already
   * posted, and there is nothing to un-break them with.
   *
   * **No avatar picker yet, deliberately.** `gphone_accounts.avatar` is `varchar(255)` and the
   * gallery hands back a base64 image — `PhotoPickerModal`'s `onselect` gives the image data, not
   * a reference — so wiring it up produces a value the server's per-column length rule rejects.
   * It is not a missing prop; it needs the column to hold a media reference, which is the
   * `gphone_media` work. Widening the column is a type change, and `SchemaMigrator` is
   * additive-only.
   *
   * `maxlength` mirrors each column so the field cannot accept what the write path would refuse.
   */
  let {
    account,
    busy = false,
    onsave,
    oncancel
  }: {
    account: Account;
    busy?: boolean;
    onsave: (patch: { display_name: string | null; bio: string | null }) => void;
    oncancel: () => void;
  } = $props();

  /**
   * Seeded at mount, deliberately — `untrack` says so rather than leaving `--fail-on-warnings`
   * to guess, and the same reasoning as `Composer`'s `initial`: tracking the prop would let a
   * store refresh overwrite what the player is halfway through typing.
   */
  const { t } = useLocale();

  let displayName = $state(untrack(() => account.display_name ?? ''));
  let bio = $state(untrack(() => account.bio ?? ''));

  const dirty = $derived(
    displayName !== (account.display_name ?? '') || bio !== (account.bio ?? '')
  );

  /** Empty means "cleared", which is a null column rather than an empty string. */
  const save = () => onsave({ display_name: displayName.trim() || null, bio: bio.trim() || null });
</script>

<div
  class="pt-safe-top animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col p-5"
>
  <h3 class="text-on-surface mb-1 text-lg font-bold">{$t('blabber.editProfile')}</h3>
  <p class="text-on-surface-variant text-body-small mb-4">
    {$t('blabber.handleFixed', { handle: account.handle })}
  </p>

  <label class="text-on-surface-variant text-body-small mb-1 block" for="blabber-display-name">
    {$t('blabber.displayName')}
  </label>
  <input
    id="blabber-display-name"
    bind:value={displayName}
    maxlength="50"
    placeholder={account.handle}
    class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium mb-4 w-full rounded-box px-3 py-2.5 focus:outline-none"
  />

  <label class="text-on-surface-variant text-body-small mb-1 block" for="blabber-bio"
    >{$t('blabber.bio')}</label
  >
  <textarea
    id="blabber-bio"
    bind:value={bio}
    maxlength="160"
    rows="3"
    placeholder={$t('blabber.bioPlaceholder')}
    class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full resize-none rounded-box p-2.5 focus:outline-none"
  ></textarea>
  <span class="text-on-surface-variant text-body-small mt-1 mb-4 text-right"
    >{160 - bio.length}</span
  >

  <div class="flex gap-2">
    <Button class="flex-1" variant="secondary" onclick={oncancel} disabled={busy}
      >{$t('blabber.cancel')}</Button
    >
    <Button class="flex-1" disabled={!dirty || busy} onclick={save}>
      {busy ? '…' : $t('blabber.save')}
    </Button>
  </div>
</div>
