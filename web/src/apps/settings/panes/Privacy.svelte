<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    PRIVACY_NOTICE_TEXT,
    SettingsSection,
    ToggleSwitch,
    useLocale,
    useStreamerMode
  } from '@mica/sdk';

  const { t } = useLocale();
  const { streamerMode, setStreamerMode } = useStreamerMode();

  /**
   * What this phone does with what a player types into it.
   *
   * Reached from the Privacy row in About rather than shown on arrival. There used to be a
   * first-run popup carrying the same words (MICA-70, item 1), removed because a modal
   * every character had to dismiss before touching the phone cost more than it bought.
   * This is now the only place the notice appears, which is the trade that was made: it is
   * always reachable and never in the way, rather than unmissable exactly once.
   *
   * The wording is `PRIVACY_NOTICE_TEXT` from the SDK and is not restated here. It is a
   * published export precisely so an add-on can show the same disclosure in the same words,
   * and a second copy in this file would be the one that drifted.
   *
   * Streamer mode (MICA-249) lives here too: it is a privacy choice about what the phone
   * puts on screen, not a display preference. One toggle, persisted per character through
   * the settings service like every other switch in this app; `MediaThumb` is what honours
   * it, on every surface at once.
   */
</script>

<div class="p-4">
  <SettingsSection title={$t('settings.privacy.title')}>
    <div class="p-4">
      <p class="text-on-surface-variant text-body-medium">{PRIVACY_NOTICE_TEXT}</p>
    </div>
  </SettingsSection>

  <SettingsSection
    title={$t('settings.privacy.pictures')}
    footer={$t('settings.privacy.streamerModeFooter')}
  >
    <ToggleSwitch
      label={$t('settings.privacy.streamerMode')}
      description={$t('settings.privacy.streamerModeDescription')}
      checked={$streamerMode}
      onchange={setStreamerMode}
    />
  </SettingsSection>
</div>
