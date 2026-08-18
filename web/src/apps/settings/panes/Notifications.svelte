<script lang="ts">
  import { SettingsSection, ToggleSwitch, useNotificationSettings } from '@gphone/sdk';
  const { toastsEnabled, notificationSoundEnabled, badgesEnabled } = useNotificationSettings();
</script>

<div class="space-y-6 p-4">
  <SettingsSection title="Banner Toasts & Alerts">
    <div class="divide-outline-variant text-body-medium divide-y">
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">Show Banner Overlay</span>
          <span class="text-on-surface-variant text-body-small"
            >Display popup banners when notifications arrive</span
          >
        </div>
        <ToggleSwitch checked={$toastsEnabled} onchange={(val) => toastsEnabled.set(val)} />
      </div>

      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">Notification Sounds</span>
          <span class="text-on-surface-variant text-body-small"
            >Play alert sound on incoming notification</span
          >
        </div>
        <ToggleSwitch
          checked={$notificationSoundEnabled}
          onchange={(val) => notificationSoundEnabled.set(val)}
        />
      </div>
    </div>
  </SettingsSection>

  <SettingsSection title="App Badges">
    <div class="flex items-center justify-between p-4">
      <div class="flex flex-col pr-4">
        <span class="text-on-surface font-medium">App Icon Badges</span>
        <span class="text-on-surface-variant text-body-small"
          >Show unread count badges on launcher icons</span
        >
      </div>
      <ToggleSwitch checked={$badgesEnabled} onchange={(val) => badgesEnabled.set(val)} />
    </div>
  </SettingsSection>
</div>
