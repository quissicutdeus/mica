<script lang="ts">
  /**
   * The first-run privacy notice (MICA-70, item 1) — shown once, the first time the
   * phone itself opens, to every character. Same structural shape as `sdk/ui/
   * ConfirmDialog.svelte` (scrim, centered card, `focusTrap`, focus moved to the dialog
   * on mount so a screen reader actually announces it) but with one action rather than
   * two: there is no "cancel" that makes sense for a disclosure, only acknowledging it.
   *
   * The permanent copy of the same text lives in Settings > About
   * (`apps/settings/panes/About.svelte`), reading the same `PRIVACY_NOTICE_TEXT` constant
   * so the two can never drift apart.
   */
  import { fade, focusTrap } from '@gphone/sdk';
  import Button from '../../../sdk/ui/Button.svelte';
  import { PRIVACY_NOTICE_TEXT, markPrivacyNoticeSeen } from './state/privacyNotice';

  let dialogRef = $state<HTMLElement | null>(null);

  $effect(() => {
    dialogRef?.focus({ preventScroll: true });
  });
</script>

<div
  class="bg-scrim absolute inset-0 z-[9999] flex items-center justify-center p-6 backdrop-blur-sm"
  transition:fade
>
  <div
    bind:this={dialogRef}
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label="Privacy notice"
    tabindex="-1"
    class="bg-surface-container shadow-elevation-5 w-full rounded-xl p-6 outline-none"
  >
    <h3 class="text-on-surface mb-2 text-xl font-bold">Privacy Notice</h3>
    <p class="text-on-surface-variant mb-6">{PRIVACY_NOTICE_TEXT}</p>
    <Button class="w-full" onclick={markPrivacyNoticeSeen}>Got it</Button>
  </div>
</div>
