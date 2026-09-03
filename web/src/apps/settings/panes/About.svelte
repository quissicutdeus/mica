<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    ChevronRightIcon,
    GOS_BUILD_INFO,
    SettingsSection,
    useAccount,
    useAppRegistry,
    useLocale,
    usePhoneNotification,
    formatDate
  } from '@gos/sdk';
  import { OS_CODENAME } from '@gos/shared/brand';

  let { ontapbuild, onprivacy, onlicense } = $props<{
    ontapbuild: () => void;
    onprivacy: () => void;
    onlicense: () => void;
  }>();

  const { t } = useLocale();
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
        ? {
            type: 'success',
            app: 'settings',
            message: $t('settings.about.copied', { number })
          }
        : { type: 'error', app: 'settings', message: $t('settings.about.copyFailed') }
    );
  };
</script>

<div class="p-4">
  <SettingsSection title={$t('settings.about.title')}>
    <div class="divide-outline-variant text-body-medium divide-y">
      <button
        type="button"
        onclick={copyPhoneNumber}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        aria-label={$t('settings.about.copyNumber')}
      >
        <span class="text-on-surface font-medium">{$t('settings.about.phoneNumber')}</span>
        <span class="text-on-surface font-mono">{$myPhoneNumber}</span>
      </button>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface font-medium">{$t('settings.about.firstBoot')}</span>
        <span class="text-on-surface text-body-small font-mono"
          >{formatDate(getFirstBootTime())}</span
        >
      </div>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface font-medium">{$t('settings.about.software')}</span>
        <span class="text-on-surface font-semibold">{$t('settings.about.softwareName')}</span>
      </div>
      <!-- OS Version carries the build info: `v1.0.0 (branch@commit)`. Was a separate
         "Build / Commit" row saying almost the same thing. Ten taps here reveal
         Developer Tools.

         The codename sits above the build stamp rather than beside it (MICA-273): the
         stamp is already long enough to wrap on the phone's 400px frame, and a release
         is known by its choir, so that is the line worth reading first. -->
      <button
        type="button"
        onclick={ontapbuild}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
      >
        <span class="text-on-surface font-medium">{$t('settings.about.osVersion')}</span>
        <span class="flex min-w-0 flex-col items-end">
          <span class="text-on-surface-variant text-body-small">{OS_CODENAME}</span>
          <span class="text-secondary font-mono">{GOS_BUILD_INFO}</span>
        </span>
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
        <span class="text-on-surface font-medium">{$t('settings.privacy.title')}</span>
        <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
      </button>
      <!-- MICA-192. A row for the same reason Privacy is one: the notice is five
           paragraphs and inlining it would bury OS Version under a wall of legal text.
           Directly under the build line on purpose — §13 asks which version's source, and
           the row above names the version. -->
      <button
        type="button"
        onclick={onlicense}
        class="hover:bg-surface-container-high active:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
      >
        <span class="text-on-surface font-medium">{$t('settings.license.title')}</span>
        <ChevronRightIcon class="text-on-surface-variant size-icon-sm" />
      </button>
    </div>
  </SettingsSection>
</div>
