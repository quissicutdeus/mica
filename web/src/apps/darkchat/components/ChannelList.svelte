<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Button, ChevronRightIcon, EmptyState, ListItem, Skeleton, useLocale } from '@mica/sdk';
  import type { DarkchatChannel } from '@mica/shared/types';

  /**
   * Every channel I am in, by name and the alias I go by there. Create and Join sit at the foot
   * whether or not the list is empty — a second channel is reached the same way as the first.
   */
  let {
    channels,
    loaded,
    onopen,
    oncreate,
    onjoin
  }: {
    channels: DarkchatChannel[];
    loaded: boolean;
    onopen: (channel: DarkchatChannel) => void;
    oncreate: () => void;
    onjoin: () => void;
  } = $props();

  const { t } = useLocale();
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex-1 overflow-y-auto" data-testid="darkchat-channels">
    {#if !loaded}
      <div class="p-4"><Skeleton count={3} height="h-16" /></div>
    {:else if channels.length === 0}
      <EmptyState title={$t('darkchat.emptyTitle')} description={$t('darkchat.emptyHint')} />
    {:else}
      {#each channels as channel (channel.id)}
        <ListItem onclick={() => onopen(channel)} class="border-outline-variant gap-3 border-b">
          <div class="min-w-0 flex-1" data-testid="darkchat-channel">
            <p class="text-on-surface text-body-large truncate font-medium">{channel.name}</p>
            <p class="text-on-surface-variant text-body-small truncate">
              {$t('darkchat.youAre', { alias: channel.my_alias })}
            </p>
          </div>
          <ChevronRightIcon class="text-on-surface-variant size-icon-sm shrink-0" />
        </ListItem>
      {/each}
    {/if}
  </div>

  <div class="border-outline-variant flex flex-col gap-2 border-t px-4 pt-3 pb-home-indicator">
    <p class="text-on-surface-variant text-body-small text-center">{$t('darkchat.ephemeral')}</p>
    <div class="flex gap-2">
      <Button variant="secondary" class="flex-1" onclick={onjoin}>{$t('darkchat.join')}</Button>
      <Button class="flex-1" onclick={oncreate}>{$t('darkchat.create')}</Button>
    </div>
  </div>
</div>
