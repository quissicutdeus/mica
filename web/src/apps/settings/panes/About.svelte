<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    ChevronRightIcon,
    MICA_BUILD_INFO,
    SettingsSection,
    useAccount,
    useAppRegistry,
    usePhoneNotification,
    formatDate
  } from '@gphone/sdk';

  let { ontapbuild, onprivacy } = $props<{ ontapbuild: () => void; onprivacy: () => void }>();

  const { myPhoneNumber } = useAccount();
  const { getFirstBootTime } = useAppRegistry();
  const { toast } = usePhoneNotification();

  /**
   * Copy the player's number so it can be pasted into a message.
   *
   * `navigator.clipboard` needs a secure context. NUI is served over
   * `https://cfx-nui-<resource>/` so it qualifies, but CEF can still refuse the
   * permission — hence the execCommand fallback, which is deprecated on the open web
   * and entirely reliable here.
   */
  const copyPhoneNumber = async () => {
    const number = $myPhoneNumber;
    let copied = false;

    try {
      await navigator.clipboard.writeText(number);
      copied = true;
    } catch {
      try {
        const scratch = document.createElement('textarea');
        scratch.value = number;
        // Keep it off-screen and unfocusable so the phone UI does not visibly shift.
        scratch.setAttribute('readonly', '');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        scratch.style.pointerEvents = 'none';
        document.body.appendChild(scratch);
        scratch.select();
        copied = document.execCommand('copy');
        document.body.removeChild(scratch);
      } catch {
        copied = false;
      }
    }

    toast.show(
      copied
        ? { type: 'success', app: 'settings', message: `Copied ${number} to clipboard` }
        : { type: 'error', app: 'settings', message: 'Could not copy your number' }
    );
  };
</script>

<div class="p-4">
  <SettingsSection title="About">
    <div class="divide-outline-variant text-body-medium divide-y">
      <button
        type="button"
        onclick={copyPhoneNumber}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        aria-label="Copy phone number to clipboard"
      >
        <span class="text-on-surface font-medium">Phone Number</span>
        <span class="text-on-surface font-mono">{$myPhoneNumber}</span>
      </button>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface font-medium">First Boot</span>
        <span class="text-on-surface text-body-small font-mono"
          >{formatDate(getFirstBootTime())}</span
        >
      </div>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface font-medium">Software</span>
        <span class="text-on-surface font-semibold">gPhone</span>
      </div>
      <!-- OS Version carries the build info: `v1.0.0 (branch@commit)`. Was a separate
         "Build / Commit" row saying almost the same thing. Ten taps here reveal
         Developer Tools. -->
      <button
        type="button"
        onclick={ontapbuild}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
      >
        <span class="text-on-surface font-medium">OS Version</span>
        <span class="text-secondary font-mono">{MICA_BUILD_INFO}</span>
      </button>
      <!-- A row rather than the paragraph itself. The notice is four sentences, and
           inlining it here made About a wall of text under a list of one-line facts.
           Its own screen also gives it room to grow without pushing OS Version — the
           row above it — off the first thing a player sees. -->
      <button
        type="button"
        onclick={onprivacy}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
      >
        <span class="text-on-surface font-medium">Privacy</span>
        <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
      </button>
    </div>
  </SettingsSection>
</div>
