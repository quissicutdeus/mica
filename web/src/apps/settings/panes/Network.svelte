<script lang="ts">
  import { SettingsSection, ToggleSwitch, useSystemHardware } from '@gphone/sdk';

  const { cellServiceEnabled, toggleCellService, bluetoothEnabled, toggleBluetooth } =
    useSystemHardware();
</script>

<div class="space-y-6 p-4">
  <SettingsSection
    title="Cellular Service"
    footer="Turning off cellular service gates connections to external services and sets signal level to 0 bars. Local apps (Notes, Camera, Photos, Calculator) operate offline."
  >
    <ToggleSwitch
      label="Cellular Service"
      description="Gate network access and external services"
      checked={$cellServiceEnabled}
      onchange={() => toggleCellService()}
    />
  </SettingsSection>

  <SettingsSection
    title="Bluetooth & Proximity"
    footer="When Bluetooth is ON, nearby devices can discover your phone for proximity features. Turning Bluetooth OFF renders your device invisible to proximity scans and blocks unsolicited contact sharing."
  >
    <ToggleSwitch
      label="Bluetooth Visibility"
      description="Short-range peer-to-peer discovery"
      checked={$bluetoothEnabled}
      onchange={() => toggleBluetooth()}
    />
  </SettingsSection>
</div>
