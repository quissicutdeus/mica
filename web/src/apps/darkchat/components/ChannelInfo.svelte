<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, ConfirmDialog, Skeleton, useAppAction, useLocale } from '@mica/sdk';
  import type { DarkchatChannel, DarkchatMember } from '@mica/shared/types';
  import { loadMembers, removeMember, revealCode, rotateCode } from '../store';
  import CodeCard from './CodeCard.svelte';

  /**
   * Who is in a channel, by alias and nothing else, and what I can do about it. Everyone can
   * leave; the owner can also show the code, replace it, and remove a member who is not them.
   * Those three are offered only to the owner, and the server refuses them to anyone else.
   */
  let {
    channel,
    onleave
  }: {
    channel: DarkchatChannel;
    onleave: () => void;
  } = $props();

  const { t } = useLocale();
  const { run, busy } = useAppAction('darkchat');

  let members = $state<DarkchatMember[] | null>(null);
  let code = $state<string | null>(null);
  let rotating = $state(false);
  let removing = $state<DarkchatMember | null>(null);

  // `run` answers whether the work succeeded, never its value, so each read lands in a local
  // the work closes over.
  const refresh = async () => {
    const id = channel.id;
    let rows = null as DarkchatMember[] | null;
    await run(
      async () => {
        rows = await loadMembers(id);
      },
      { title: $t('darkchat.title') }
    );
    if (rows) members = rows;
  };

  $effect(() => {
    void channel.id;
    untrack(() => {
      members = null;
      code = null;
      void refresh();
    });
  });

  const show = async () => {
    let next = null as string | null;
    await run(
      async () => {
        next = await revealCode(channel.id);
      },
      { title: $t('darkchat.title') }
    );
    if (next) code = next;
  };

  const rotate = async () => {
    let next = null as string | null;
    await run(
      async () => {
        next = await rotateCode(channel.id);
      },
      { title: $t('darkchat.title'), success: $t('darkchat.rotated') }
    );
    if (next) code = next;
    rotating = false;
  };

  const remove = async () => {
    const target = removing;
    if (!target) return;
    const ok = await run(() => removeMember(channel.id, target.id), {
      title: $t('darkchat.title'),
      success: $t('darkchat.removed')
    });
    if (ok) members = (members ?? []).filter((m) => m.id !== target.id);
    removing = null;
  };
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pb-home-indicator">
  <div class="space-y-1">
    <p class="text-on-surface text-title-medium font-medium">{channel.name}</p>
    <p class="text-on-surface-variant text-body-small">
      {$t('darkchat.youAre', { alias: channel.my_alias })}
      {#if channel.is_owner}{$t('darkchat.ownerNote')}{/if}
    </p>
  </div>

  {#if channel.is_owner}
    <div class="space-y-2">
      {#if code}
        <CodeCard {code} />
      {:else}
        <Button variant="secondary" class="w-full" disabled={$busy} onclick={() => void show()}>
          {$t('darkchat.showCode')}
        </Button>
      {/if}
      <Button variant="secondary" class="w-full" disabled={$busy} onclick={() => (rotating = true)}>
        {$t('darkchat.rotateCode')}
      </Button>
    </div>
  {/if}

  <div>
    <p class="text-on-surface-variant text-label-large mb-2">{$t('darkchat.members')}</p>
    {#if members === null}
      <Skeleton count={3} height="h-10" />
    {:else}
      <ul class="bg-surface-container overflow-hidden rounded-box" data-testid="darkchat-members">
        {#each members as member, index (member.id)}
          {@const me = member.id === channel.my_member_id}
          <li
            class="border-outline-variant flex items-center gap-3 px-4 py-2.5"
            class:border-b={index < members.length - 1}
          >
            <span class="text-on-surface text-body-medium min-w-0 flex-1 truncate">
              {member.alias}{#if me}<span class="text-on-surface-variant">
                  · {$t('darkchat.you')}</span
                >{/if}
            </span>
            {#if channel.is_owner && !me}
              <button
                type="button"
                class="text-error text-label-large shrink-0 cursor-pointer px-2 py-1 disabled:opacity-50"
                disabled={$busy}
                aria-label={$t('darkchat.removeMemberLabel', { alias: member.alias })}
                onclick={() => (removing = member)}
              >
                {$t('darkchat.removeMember')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <Button variant="danger" class="mt-auto w-full" disabled={$busy} onclick={onleave}>
    {$t('darkchat.leave')}
  </Button>
</div>

{#if rotating}
  <ConfirmDialog
    title={$t('darkchat.rotateTitle')}
    message={$t('darkchat.rotateMessage')}
    confirmText={$t('darkchat.rotate')}
    isLoading={$busy}
    onconfirm={() => void rotate()}
    oncancel={() => (rotating = false)}
  />
{:else if removing}
  <ConfirmDialog
    title={$t('darkchat.removeTitle', { alias: removing.alias })}
    message={$t('darkchat.removeMessage')}
    confirmText={$t('darkchat.removeMember')}
    confirmVariant="danger"
    isLoading={$busy}
    onconfirm={() => void remove()}
    oncancel={() => (removing = null)}
  />
{/if}
