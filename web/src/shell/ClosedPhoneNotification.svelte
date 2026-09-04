<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { closedPhoneToast } from './state/toast';
  import { frameMargin, phoneBox, viewportSize } from './state/display';
  import { fly } from '@mica/sdk';
  import Avatar from '../../../sdk/ui/Avatar.svelte';
  import { appRegistryStore } from './state/registry';

  let current = $derived($closedPhoneToast);
  let manifest = $derived(current?.app ? appRegistryStore.getManifest(current.app) : undefined);

  /**
   * The same bottom-right placement `Shell.svelte` gives the real phone (`items-end
   * justify-end` inside a `padding: {$frameMargin}px` box) — recomputed here from the same
   * `state/display.ts` stores, rather than passed down, because this renders precisely
   * when `Shell.svelte`'s own phone box does not exist to measure. Lining the card up with
   * where the phone's top edge normally sits is what reads as "the top of the phone" the
   * ticket asks for, even though there is no bezel underneath it to draw.
   */
  let left = $derived($viewportSize.width - $frameMargin - $phoneBox.width);
  let top = $derived($viewportSize.height - $frameMargin - $phoneBox.height);
</script>

<!-- Closed-phone notification peek (MICA-141).

     Non-interactive on purpose — this is a glance, not a second `ToastHost`. Tapping it to
     open the phone would need `Shell.svelte`'s own `visible` rune, which nothing outside
     that component can set (`state/phoneOpen.ts`'s docblock), and building that path is
     more than a three-second glance calls for. It disappears on its own
     (`toast.ts`'s `peekWhileClosed`) or the instant the phone actually opens. -->
{#if current}
  {@const t = current}
  <div
    data-testid="closed-phone-notification"
    class="pointer-events-none fixed z-80 flex justify-center"
    style="left: {left}px; top: {top}px; width: {$phoneBox.width}px;"
  >
    <div
      transition:fly={{ y: -40, duration: 300 }}
      class="bg-surface-container-high border-outline-variant text-on-surface shadow-elevation-4 m-2 flex w-full items-start gap-3 rounded-box border p-3.5 backdrop-blur-md"
    >
      {#if t.avatar || t.sender || t.type === 'message' || t.type === 'contact'}
        <div class="shrink-0">
          <Avatar
            src={t.avatar}
            initials={t.sender ? t.sender[0] : t.title ? t.title[0] : 'N'}
            size="w-9 h-9"
            textClass="text-sm"
          />
        </div>
      {/if}

      <div class="min-w-0 flex-1">
        {#if manifest}
          <div class="mb-1 flex items-center gap-1.5">
            <Avatar
              src={typeof manifest.icon === 'string' ? manifest.icon : ''}
              initials={manifest.name.charAt(0)}
              bgClass={manifest.color}
              size="size-icon-sm"
              textClass="text-label-small"
            />
            <span class="text-primary text-body-small truncate tracking-wide uppercase">
              {manifest.name}
            </span>
          </div>
        {/if}
        {#if t.title}
          <h4 class="text-on-surface text-body-medium mb-0.5 truncate">{t.title}</h4>
        {/if}
        <p class="text-on-surface text-body-small line-clamp-2 leading-relaxed">
          {t.message}
        </p>
      </div>
    </div>
  </div>
{/if}
