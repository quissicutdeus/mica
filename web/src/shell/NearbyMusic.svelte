<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The off switch for everybody else's music. MICA-111 phase 2, shell half.
   *
   * ## Why this is in the shade and not only in the Music app
   *
   * Music that other people can hear is a griefing surface — the ticket says so, and the
   * comment promoting mute from an open question to a requirement says why: the first
   * person to play something appalling in a crowded area is, without this, unmuteable by
   * everyone in earshot. A mute that lives one app-open, one scroll and one row away from
   * the person being harassed is a mute they will not find while it is happening.
   *
   * So the global switch is here, in the shade: one pull from any screen, app or home, and
   * it needs no idea whose music it is. That last part is the point — somebody reaching
   * for this does not know and should not have to work out which of four people standing
   * around them is the one playing it. **Per-broadcaster mute is the Music app's job**,
   * where there is room for a list and a name; this is the one that does not need either.
   *
   * It sits with `NowPlaying` between the quick-settings tiles and the notification list,
   * for the reasons that file gives at more length: the list below is an unbounded
   * scroller and a control below it is off-screen exactly when a lot is going on.
   *
   * ## It is not a notification, and nothing here is dismissible
   *
   * Same as `NowPlaying`: nothing routes through `state/notificationPolicy.ts`, so Do Not
   * Disturb cannot hide it and Clear All cannot remove it. A control that could be
   * dismissed while the noise carried on would be the original problem in a new shape.
   *
   * ## When it shows, and the case that decides it
   *
   * Whenever anybody nearby is broadcasting — **including when they are all muted**. It
   * would be tidier to hide the row once the mute is on, and it would be wrong: the row is
   * also the only way back. A person who muted everyone last week and has forgotten needs
   * to see, at the moment music is actually being played near them, that the reason they
   * cannot hear it is a switch they threw. Hidden, that is an unfalsifiable bug report.
   *
   * When nobody is playing anything it renders nothing at all, mute or no mute: there is
   * no noise to complain about, and a standing preference does not need a permanent row.
   */
  import {
    audibleBroadcasts,
    muteAllNearby,
    nearbyBroadcasts,
    toggleMuteAllNearby
  } from './state/nearbyMusic';
  import { openApp } from './state/navigation';
  import { closeShade } from './state/shade';
  import SpeakerIcon from '../../../sdk/ui/icons/SpeakerIcon.svelte';
  import SpeakerOffIcon from '../../../sdk/ui/icons/SpeakerOffIcon.svelte';
  import UsersIcon from '../../../sdk/ui/icons/UsersIcon.svelte';

  const nearby = $derived($nearbyBroadcasts.length);
  const audible = $derived($audibleBroadcasts.length);

  /**
   * The one line this row has, and it has to distinguish three states that look alike.
   *
   * "Muted" is unambiguous. The interesting one is the third: some people nearby are
   * playing and you cannot hear all of them, because the cap allows three at once
   * (`lib/phone/musicRanking.ts`). Saying so is the difference between a rule and a bug —
   * without it, a person standing in a crowd hears three of the five stereos around them
   * and has no way to learn that that is deliberate.
   */
  const detail = $derived.by(() => {
    if ($muteAllNearby) return nearby === 1 ? '1 nearby · muted' : `${nearby} nearby · muted`;
    const people = nearby === 1 ? '1 person nearby' : `${nearby} people nearby`;
    if (audible < nearby) return `${people} · playing the closest ${audible}`;
    return people;
  });

  const openMusicApp = () => {
    // Close first: the shade is `inset-0` over the whole screen, so leaving it open would
    // land the person on the app they asked for with the shade still covering it.
    closeShade();
    openApp('music');
  };
</script>

{#if nearby > 0}
  <!-- `px-6` to sit on the same gutter as the header, the tiles and `NowPlaying`. -->
  <div class="mb-4 px-6">
    <div
      data-testid="nearby-music"
      class="bg-surface flex items-center gap-2 rounded-lg p-2"
      role="group"
      aria-label="Nearby music"
    >
      <button
        type="button"
        class="hover:bg-surface-container duration-short ease-standard flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left transition-colors"
        onclick={openMusicApp}
        title="Open Music"
      >
        <!-- Muted is drawn in the muted role rather than the accent: the colour has to say
             the same thing as the word, or a silenced street still reads as normal. -->
        <UsersIcon
          class="{$muteAllNearby
            ? 'text-on-surface-variant'
            : 'text-primary'} size-icon-sm shrink-0"
        />
        <span class="min-w-0 flex-1">
          <span
            class="text-label-small {$muteAllNearby
              ? 'text-on-surface-variant'
              : 'text-primary'} block tracking-wider uppercase">Nearby music</span
          >
          <span class="text-body-small text-on-surface block truncate">{detail}</span>
        </span>
      </button>

      <!-- The whole reason this row exists. One tap, no names, no list, and it stays on
           until it is turned off — see `muteAllNearby` for why it is a standing switch
           rather than "silence the people who happen to be here now". -->
      <button
        type="button"
        class="bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard shrink-0 rounded-full p-2 transition-colors"
        onclick={toggleMuteAllNearby}
        aria-pressed={$muteAllNearby}
        title={$muteAllNearby ? 'Unmute nearby music' : 'Mute all nearby music'}
        aria-label={$muteAllNearby ? 'Unmute nearby music' : 'Mute all nearby music'}
      >
        {#if $muteAllNearby}
          <SpeakerOffIcon class="size-icon-sm" />
        {:else}
          <SpeakerIcon class="size-icon-sm" />
        {/if}
      </button>
    </div>
  </div>
{/if}
