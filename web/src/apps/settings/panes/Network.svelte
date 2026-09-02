<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    SettingsSection,
    ToggleSwitch,
    useLocale,
    useSystemHardware,
    useSystemHardwareWrite
  } from '@gphone/sdk';

  const { t } = useLocale();
  const { cellServiceEnabled, bluetoothEnabled } = useSystemHardware();
  const { toggleCellService, toggleBluetooth } = useSystemHardwareWrite();
</script>

<div class="space-y-6 p-4">
  <SettingsSection
    title={$t('settings.network.cellularTitle')}
    footer={$t('settings.network.cellularFooter')}
  >
    <ToggleSwitch
      label={$t('settings.network.cellularLabel')}
      description={$t('settings.network.cellularDescription')}
      checked={$cellServiceEnabled}
      onchange={() => toggleCellService()}
    />
  </SettingsSection>

  <SettingsSection
    title={$t('settings.network.bluetoothTitle')}
    footer={$t('settings.network.bluetoothFooter')}
  >
    <ToggleSwitch
      label={$t('settings.network.bluetoothLabel')}
      description={$t('settings.network.bluetoothDescription')}
      checked={$bluetoothEnabled}
      onchange={() => toggleBluetooth()}
    />
  </SettingsSection>
</div>
