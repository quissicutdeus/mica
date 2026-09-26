<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The phone body's camera cutout and colour (MICA-236). Cosmetic only: every variant sits
   * inside the same 400x850 box, so no app's layout depends on the choice. "Server default"
   * is the setting cleared, which follows the owner's `mica_default_frame`.
   */
  import { SegmentedControl, SettingsSection, useLocale } from '@mica/sdk';
  import {
    FRAME_CHOICES,
    FRAME_COLOR_CHOICES,
    frameColorSetting,
    frameSetting,
    chooseFrame,
    chooseFrameColor
  } from '../frame';

  const { t } = useLocale();

  const FRAME_OPTIONS = $derived([
    { id: '', label: $t('settings.frame.default') },
    ...FRAME_CHOICES.map((id) => ({ id, label: $t(`settings.frame.${id}`) }))
  ]);
  const COLOR_OPTIONS = $derived(
    FRAME_COLOR_CHOICES.map(({ id }) => ({ id, label: $t(`settings.frame.color.${id}`) }))
  );
  const color = $derived($frameColorSetting || 'black');
</script>

<SettingsSection title={$t('settings.frame.section')} footer={$t('settings.frame.footer')}>
  <div class="flex flex-col gap-3 p-4" data-testid="frame-picker">
    <SegmentedControl
      options={FRAME_OPTIONS}
      selected={$frameSetting}
      aria-label={$t('settings.frame.label')}
      onchange={(id: string) => chooseFrame(id)}
    />
    <SegmentedControl
      options={COLOR_OPTIONS}
      selected={color}
      aria-label={$t('settings.frame.colorLabel')}
      onchange={(id: string) => chooseFrameColor(id)}
    />
  </div>
</SettingsSection>
