<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { fade } from '../lib/motion';
  import Button from './Button.svelte';
  import { useReport } from '../host/useReport';
  import { usePhoneNotification } from '../host/usePhoneNotification';
  import type { ReportCategory } from '@mica/shared/types';
  import { messageOf } from '../lib/errors';
  import { focusTrap } from '../lib/focusTrap';
  import { t } from '../i18n';
  import './messages';

  interface Props {
    /** The micaOS table the content lives in. Validated again server-side. */
    /**
     * The table the reported row lives in, as its service declared it reportable.
     *
     * A plain string, deliberately. It was briefly a union naming every table — which
     * meant this file, in the SDK that add-ons build *against*, named `mica_blabber`:
     * core knowing about an app rather than the other way round, and the reason a
     * third-party app could not have made its own content reportable at all.
     *
     * The check that matters is server-side and unchanged: `target_table` is interpolated
     * into SQL because MySQL cannot parameterise an identifier, so `isReportableTable`
     * refuses anything no service declared (§2.9). A union here would have been a
     * convenience on top of that, bought at the price of a closed system.
     */
    targetTable: string;
    targetId: number;
    /** Which app's icon/name a confirmation toast identifies itself with. */
    appId?: string;
    onclose: () => void;
  }

  let { targetTable, targetId, appId, onclose }: Props = $props();

  const { submit: submitReport } = useReport();
  const { toast, sendNotification } = usePhoneNotification();

  /**
   * Tells the player how the report went, in whichever way this side of the wall can.
   *
   * In-process `toast` is the shell's store and has `show`, which puts `appId`'s icon on the
   * toast. In a `core: false` add-on's frame `toast` is a read-only twin with no `show` at
   * all, and calling it threw after the report had already gone (MICA-254). It stays absent
   * on purpose: `show` takes an `app`, and a frame choosing that could wear another app's
   * icon. `sendNotification` is the member the frame is already answered on, and the shell
   * files it under the add-on's own id, so the frame's toast claims no other app. The hook
   * names no app here because `appId` is a prop, and neither side would read the id: `show`
   * is given `appId` itself, and the shell pins a frame's. It is async over the wire, and a
   * refusal there must not escape into the submit that already succeeded.
   */
  const tell = (type: 'success' | 'error', message: string) => {
    if (typeof toast.show === 'function') {
      toast.show({ type, app: appId, message });
      return;
    }
    Promise.resolve()
      .then(() => sendNotification({ type, message }))
      .catch((e: unknown) => console.warn('[micaOS] The report notice could not be shown.', e));
  };

  // The key, not the word: this list is module-level and would otherwise freeze whichever
  // locale happened to be active when the component first ran.
  const CATEGORIES: { id: ReportCategory; key: string }[] = [
    { id: 'harassment', key: 'ui.reportHarassment' },
    { id: 'threats', key: 'ui.reportThreats' },
    { id: 'sexual', key: 'ui.reportSexual' },
    { id: 'spam', key: 'ui.reportSpam' },
    { id: 'impersonation', key: 'ui.reportImpersonation' },
    { id: 'other', key: 'ui.reportOther' }
  ];

  let category = $state<ReportCategory>('harassment');
  let note = $state('');
  let sending = $state(false);

  /** Matches the server's cap, so the field cannot accept what would be silently cut. */
  const MAX_NOTE = 500;

  let dialogRef = $state<HTMLElement | null>(null);

  /** Announce the sheet on open, and start Tab inside it — see `ConfirmDialog`. */
  $effect(() => {
    dialogRef?.focus({ preventScroll: true });
  });

  const submit = async () => {
    sending = true;
    try {
      await submitReport({ targetTable, targetId, category, note: note.trim() || undefined });
      tell('success', $t('ui.reportSent'));
      onclose();
    } catch (e) {
      tell('error', messageOf(e, $t('ui.reportFailed')));
    } finally {
      sending = false;
    }
  };
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-end backdrop-blur-sm"
  transition:fade={{ duration: 150 }}
>
  <!-- A real dialog, and it has to be: this sheet covers the post it was opened from, and
       the post's own buttons stay in the tab order behind it. See `lib/focusTrap.ts`. -->
  <div
    bind:this={dialogRef}
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={$t('ui.reportContent')}
    tabindex="-1"
    class="bg-surface max-h-full w-full overflow-y-auto rounded-t-xl p-5 outline-none"
  >
    <h3 class="text-on-surface mb-1 text-lg font-bold">{$t('ui.reportContent')}</h3>
    <p class="text-on-surface-variant text-body-medium mb-4">
      {$t('ui.reportContentNote')}
    </p>

    <div class="mb-4 space-y-1.5">
      {#each CATEGORIES as option (option.id)}
        <button
          type="button"
          onclick={() => (category = option.id)}
          aria-pressed={category === option.id}
          class="text-body-medium flex w-full cursor-pointer items-center justify-between rounded-box border px-4 py-3 text-left transition-colors {category ===
          option.id
            ? 'border-error bg-error-container text-on-error-container'
            : 'border-outline-variant bg-surface-container text-on-surface hover:bg-surface-container-high'} duration-short ease-standard"
        >
          {$t(option.key)}
          {#if category === option.id}
            <span class="text-error">●</span>
          {/if}
        </button>
      {/each}
    </div>

    <textarea
      bind:value={note}
      maxlength={MAX_NOTE}
      rows="3"
      placeholder={$t('ui.reportNotePlaceholder')}
      class="border-outline-variant bg-surface-container text-on-surface placeholder-on-surface-variant focus:border-error text-body-medium mb-4 w-full resize-none rounded-box border p-3 focus:outline-none"
    ></textarea>

    <div class="flex gap-3">
      <Button class="flex-1" variant="secondary" onclick={onclose} disabled={sending}
        >{$t('ui.cancel')}</Button
      >
      <Button class="flex-1" variant="danger" onclick={submit} disabled={sending}>
        {sending ? $t('ui.reportSending') : $t('ui.report')}
      </Button>
    </div>
  </div>
</div>
