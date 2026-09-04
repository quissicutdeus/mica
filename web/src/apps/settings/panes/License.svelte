<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    LICENSE_COPYRIGHT,
    LICENSE_FREEDOMS,
    LICENSE_NAME,
    LICENSE_SOURCE_OFFER,
    LICENSE_WARRANTY,
    SettingsSection,
    sourceUrlForBuild,
    useLocale,
    usePhoneNotification,
    useSourceUrl
  } from '@mica/sdk';

  /**
   * MICA-192 stage 5: the licence, where a player can actually reach it.
   *
   * AGPL §0 wants a copyright notice, the absence of warranty, the fact that the work may be
   * conveyed under this licence, and how to view it. §13 adds the one that matters for a
   * resource players connect to: they are remote users, and an operator running a modified
   * copy owes them its source.
   *
   * A pane rather than rows inlined into About, for the reason the Privacy row already
   * records: this is five paragraphs of legal text, and putting it under a list of one-line
   * facts turns About into a wall. Reached from About and returning to it, with its own
   * level in `useAppLevels` so Back does not drop two screens.
   *
   * Shown on request rather than on arrival, following MICA-70's precedent when the
   * privacy notice stopped being a first-run modal. §0 asks for a notice that is
   * "prominently visible" in an interactive program; a row in About that is always there
   * and never in the way is this project's reading of that, and the same reading it already
   * applied to a disclosure with a stronger claim to interrupting somebody.
   *
   * Every string is a published SDK export, never restated here — an add-on is covered by
   * the same licence with no linking exception, so it can show the same words, and a second
   * copy in this file would be the one that drifted.
   */

  const { t } = useLocale();
  const { toast } = usePhoneNotification();

  /**
   * The base comes from the server, the branch from this build.
   *
   * An operator running a fork sets `mica_source_url` and their players get their source;
   * everyone else gets upstream, which is true for them. The branch is still the running
   * build's own, so the address names the code in front of the player rather than whatever
   * the repository's default branch happens to be.
   */
  const { sourceUrl: sourceUrlStore, refreshSourceUrl } = useSourceUrl();
  refreshSourceUrl();

  const sourceUrl = $derived(sourceUrlForBuild($sourceUrlStore));

  /**
   * Copy rather than open, and that is a CEF constraint rather than a preference.
   *
   * AGENTS.md §6 bans `window.location`, `window.open` and anchor navigation: each reloads
   * the CEF instance and drops every bit of state the phone is holding, so a clickable
   * source link would cost the player their session. `app.css` also sets `user-select: none`
   * globally, so they cannot select the address and copy it by hand either. Copying it to
   * the clipboard is what is left, and it is the same affordance About already uses for the
   * player's phone number — including its `execCommand` fallback, which is deprecated on the
   * open web and entirely reliable here.
   */
  const copySource = async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(sourceUrl);
      copied = true;
    } catch {
      const field = document.createElement('textarea');
      field.value = sourceUrl;
      field.setAttribute('readonly', '');
      document.body.appendChild(field);
      field.select();
      copied = document.execCommand('copy');
      document.body.removeChild(field);
    }

    toast.show(
      copied
        ? { type: 'success', app: 'settings', message: $t('settings.license.copied') }
        : { type: 'error', app: 'settings', message: $t('settings.license.copyFailed') }
    );
  };
</script>

<div class="space-y-4 p-4">
  <SettingsSection title={$t('settings.license.title')}>
    <div class="space-y-3 p-4">
      <p class="text-on-surface text-body-medium font-medium">{LICENSE_COPYRIGHT}</p>
      <p class="text-on-surface-variant text-body-medium">{LICENSE_FREEDOMS}</p>
      <p class="text-on-surface-variant text-body-medium">{LICENSE_WARRANTY}</p>
      <p class="text-on-surface-variant text-body-small">{LICENSE_NAME}</p>
    </div>
  </SettingsSection>

  <SettingsSection title={$t('settings.license.source')}>
    <div class="space-y-3 p-4">
      <p class="text-on-surface-variant text-body-medium">{LICENSE_SOURCE_OFFER}</p>
      <p class="text-secondary text-body-small font-mono break-all">{sourceUrl}</p>
      <button
        type="button"
        onclick={copySource}
        class="bg-secondary text-on-secondary text-body-small duration-short ease-standard rounded-box w-full cursor-pointer px-3 py-2 transition active:scale-95"
      >
        {$t('settings.license.copyButton')}
      </button>
    </div>
  </SettingsSection>
</div>
