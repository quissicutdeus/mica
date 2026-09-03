<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * Which language the phone speaks (MICA-61).
   *
   * The list is whatever any registered catalog provides — `availableLocales()` — so a
   * language appears here the moment one app ships it, and "Automatic" is the setting
   * cleared: the server's `gos_locale` default, then the player's own browser
   * language, then English. Names are the language's own, from `Intl.DisplayNames`, so a
   * player who cannot read the current language can still find theirs.
   */
  import { SettingsSection, useLocale } from '@gos/sdk';
  import { localeSetting } from '../locale';

  const { locale, setLocale, t, availableLocales } = useLocale();

  const nameOf = (tag: string): string => {
    try {
      return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    } catch {
      return tag;
    }
  };

  const choices = availableLocales();
</script>

<div class="space-y-6 p-4">
  <SettingsSection title={$t('settings.language.section')} footer={$t('settings.language.footer')}>
    <div class="divide-outline-variant text-body-medium divide-y">
      <button
        type="button"
        class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
        aria-pressed={$localeSetting === ''}
        onclick={() => setLocale('')}
      >
        <div class="flex min-w-0 flex-col">
          <span class="text-on-surface">{$t('settings.language.automatic')}</span>
          <span class="text-on-surface-variant text-body-small">
            {$t('settings.language.automaticHint', { locale: nameOf($locale) })}
          </span>
        </div>
        {#if $localeSetting === ''}
          <span class="text-primary text-body-small">✓</span>
        {/if}
      </button>
      {#each choices as tag (tag)}
        <button
          type="button"
          class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
          aria-pressed={$localeSetting === tag}
          onclick={() => setLocale(tag)}
        >
          <span class="text-on-surface">{nameOf(tag)}</span>
          {#if $localeSetting === tag}
            <span class="text-primary text-body-small">✓</span>
          {/if}
        </button>
      {/each}
    </div>
  </SettingsSection>
</div>
