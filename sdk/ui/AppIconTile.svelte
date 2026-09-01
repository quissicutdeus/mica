<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  /**
   * An app's tile and glyph, at one of four sizes. The only thing that draws one.
   *
   * There were six copies of this markup — the launcher's `AppIcon`, Settings' app list and
   * app info pane, the Store's catalog list, installed list and detail page — and every one
   * of them had drifted, in ways that showed:
   *
   * - **The corner radius did not scale with the tile.** `--radius-xl` is 28px, so the
   *   Store's 44px catalog rows clamped to a circle while the launcher's 56px tiles read as
   *   squares. Same token, same intent, two different shapes, and no way to tell from the
   *   markup that it would happen.
   * - **Nothing sized the glyph.** Every `Icon.svelte` defaults its `class` to `h-8 w-8`, so
   *   a component icon rendered 32px whatever it was sitting in — fine in a 56px launcher
   *   tile, nearly edge to edge in Settings' 36px row.
   * - **`invert filter` on every `<img>`.** It was there to force a dark glyph light, from
   *   when a remote icon was assumed to be dark artwork. A catalog icon now carries a colour
   *   chosen against the tile it sits on (see `scripts/lib/app-icons.js`), so inverting it
   *   is precisely wrong: it turns the white glyph black on a saturated tile.
   * - **`startsWith('http')`** guarded the two Settings surfaces, which was already narrow
   *   and became a bug when catalog icons arrived as `data:` URIs — they fell through to the
   *   first-letter fallback, which is why an installed add-on showed a letter in Settings and
   *   its real glyph everywhere else.
   *
   * So the sizes are a scale rather than six independent guesses. Each pairs a tile with a
   * glyph at a little over half of it, and the elevation that surface was already using. The
   * corner comes from `--radius-box` like every other rectangle in the phone, so a tile at
   * any size is the same shape as the row it sits in.
   */

  let {
    name,
    icon: Icon,
    color,
    size = 'lg',
    class: className = ''
  }: {
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see manifest.ts's Icon field
    icon: Component<any> | Snippet | string | null;
    /** The `bg-`/`text-` pair from the manifest's tile. */
    color: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  } = $props();

  const SIZES = {
    sm: {
      box: 'h-9 w-9 rounded-box shadow-elevation-1',
      glyph: 'size-icon-md',
      letter: 'text-body-medium'
    },
    md: {
      box: 'h-11 w-11 rounded-box shadow-elevation-1',
      glyph: 'size-icon-lg',
      letter: 'text-body-large'
    },
    lg: {
      box: 'h-14 w-14 rounded-box shadow-elevation-3',
      glyph: 'h-8 w-8',
      letter: 'text-title-medium'
    },
    xl: {
      box: 'h-20 w-20 rounded-box shadow-elevation-3',
      glyph: 'h-11 w-11',
      letter: 'text-title-medium'
    }
  } as const;

  const tile = $derived(SIZES[size]);
</script>

<div class="{tile.box} {color} flex shrink-0 items-center justify-center {className}">
  {#if typeof Icon === 'string'}
    <!--
      `alt=""`: every surface that draws a tile prints the app's name beside or beneath it,
      so a name here is the same word announced twice.
    -->
    <img src={Icon} alt="" class="{tile.glyph} pointer-events-none object-contain" />
  {:else if Icon}
    {@const Glyph = Icon}
    <Glyph class={tile.glyph} />
  {:else}
    <span class="text-on-surface {tile.letter} font-medium">{name.charAt(0).toUpperCase()}</span>
  {/if}
</div>
