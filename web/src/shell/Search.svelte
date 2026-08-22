<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/pointerDrag';
  import { isAdmin } from '../services/admin';
  import { contacts } from '../services/contacts';
  import { conversationsStore } from '../services/conversations';
  import { appRegistryStore } from './state/registry';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import { closeDrawer, isDrawerOpen } from './state/appDrawer';
  import {
    closeSearch,
    isSearchOpen,
    openSearch,
    searchDragPhase,
    searchDragProgress,
    searchQuery
  } from './state/search';
  import { searchEverything, type SearchResult } from './state/searchResults';
  import SearchIcon from '../sdk/ui/icons/SearchIcon.svelte';

  /**
   * The shell's own `openApp(id, props)` from `navigation.ts`, not the single-argument
   * launcher callback the Dock and Launcher are handed. Typed with the second argument
   * because this component is the only home-screen surface that deep-links: opening a
   * contact or a conversation means naming *which* one.
   */
  let { openApp } = $props<{
    openApp: (id: string, props?: Record<string, unknown>) => void;
  }>();

  let inputRef = $state<HTMLInputElement | null>(null);
  let sheetElement = $state<HTMLElement | null>(null);

  /**
   * Search never fetches. It reads the same three stores the apps themselves read, and it
   * can do that because Contacts and Messages both declare a `preload` in their manifests
   * that `bootstrapStores` runs when the phone opens — so both lists are already populated
   * before the home screen paints, whether or not the player has ever opened those apps.
   *
   * That is load-bearing rather than incidental: an app that dropped its `preload` would
   * not break its own screens (they load on foreground) but would quietly disappear from
   * search results until it had been opened once.
   */
  const results = $derived(
    searchEverything(
      $searchQuery,
      { apps: $appRegistryStore, contacts: $contacts, conversations: $conversationsStore },
      { isAdmin: $isAdmin }
    )
  );

  /**
   * Group headers are derived from the result order rather than stored on each result:
   * `searchEverything` already guarantees apps-then-contacts-then-messages, so a header
   * belongs exactly where a result's kind differs from its predecessor's.
   */
  const GROUP_LABEL: Record<SearchResult['kind'], string> = {
    app: 'Apps',
    contact: 'Contacts',
    message: 'Messages'
  };

  function open() {
    // The drawer and the search sheet occupy the same screen and the same z-band; opening
    // one on top of the other would leave the drawer's scrim swallowing taps meant for
    // these results.
    if (get(isDrawerOpen)) closeDrawer();
    openSearch();
  }

  function launch(result: SearchResult) {
    closeSearch();
    if (result.kind === 'app') {
      openApp(result.id);
    } else if (result.kind === 'contact') {
      openApp('contacts', { initialContact: result.contact });
    } else {
      openApp('messages', { conversationId: result.conversationId });
    }
  }

  /**
   * `Shell.svelte` renders this component only while the home screen is showing, so
   * anything that opens an app over an open search — an incoming call, a notification deep
   * link — takes the sheet away without any of its own close paths running. Left open,
   * `openSearch`'s `back` handler stays registered and unscoped, and `activeHandlerFor`
   * would hand it a later Back press meant for whatever is actually on screen: the player
   * would press Back and have nothing happen, because it went to a search that is not
   * there.
   */
  onDestroy(closeSearch);

  // Focus follows the sheet, not the mount: the input only exists while open, and it has
  // to be the focused element for typing to reach it without a second tap.
  $effect(() => {
    if ($isSearchOpen && inputRef) inputRef.focus();
  });

  /**
   * Swipe down anywhere on the sheet to dismiss — the same gesture, thresholds and easing
   * as the App Drawer's own close-drag, so the two sheets behave identically. Unlike the
   * drawer this one needs no `shouldStart` guard against its scroll container: the result
   * list is short by construction (`SEARCH_RESULTS_PER_GROUP` per group) and any drag that
   * does start mid-list still resolves to open-or-closed rather than stranding the sheet.
   */
  $effect(() => {
    if (!sheetElement) return;
    return attachDragGesture(sheetElement, {
      axis: 'y',
      shouldStart: (event) => !(event.target as HTMLElement | null)?.closest('input, button'),
      onMove: (deltaY) => {
        searchDragPhase.set('dragging');
        searchDragProgress.set(clampProgress(1 - deltaY / SHADE_DRAG_REVEAL_DISTANCE));
      },
      onEnd: (_deltaY, velocity) => {
        searchDragPhase.set('settling');
        if (shouldCommitDrag(1 - get(searchDragProgress), velocity)) {
          closeSearch();
        } else {
          searchDragProgress.set(1);
        }
      }
    });
  });
</script>

<!-- Collapsed search bar.

     `bottom-8` puts it in the band between `PhoneFrame.svelte`'s home-indicator gesture bar
     (`bottom-0`, `h-6`) and the Dock, which moved from `bottom-10` to `bottom-20` to make
     room — along with the first-run hint, from `bottom-32` to `bottom-44`. Both moved by the
     same 40px, so the gap the hint/Dock overlap regression test guards is unchanged.

     `px-4` and `rounded-full`: the padding is `Dock.svelte`'s and `Launcher.svelte`'s, which
     is what makes the bar's ends line up with the outermost icon columns above it rather
     than with the screen edge.

     Hidden while the sheet is open — the sheet carries its own copy of the input at the top
     of the screen, and two search fields on screen at once is one too many. -->
{#if !$isSearchOpen}
  <div class="absolute inset-x-0 bottom-8 z-20 px-4">
    <button
      type="button"
      onclick={open}
      class="bg-surface-container-high text-on-surface-variant text-body-medium shadow-elevation-2 duration-short ease-standard flex h-11 w-full cursor-pointer items-center gap-2 rounded-full px-4 backdrop-blur-md transition-colors hover:brightness-110"
      aria-label="Search"
    >
      <SearchIcon class="h-4 w-4" />
      <span>Search</span>
    </button>
  </div>
{/if}

{#if $isSearchOpen || $searchDragPhase !== 'idle'}
  {@const effectiveProgress =
    $searchDragPhase === 'idle' ? ($isSearchOpen ? 1 : 0) : $searchDragProgress}

  <div
    transition:fade={{ duration: 200 }}
    class="bg-scrim absolute inset-0 z-40 backdrop-blur-sm"
    onclick={closeSearch}
    role="presentation"
  ></div>

  <!-- `top-10`, matching `AppDrawer.svelte` exactly: this is the same bottom sheet, and it
       stops short of the status bar and hole-punch camera for the same reason. -->
  <div
    bind:this={sheetElement}
    transition:fly={{ y: 850, duration: $searchDragPhase === 'idle' ? 300 : 0 }}
    class="bg-surface-container-high text-on-surface shadow-elevation-5 absolute inset-x-0 top-10 bottom-0 z-55 flex flex-col rounded-t-xl px-4 pt-10 pb-2 backdrop-blur-3xl {$searchDragPhase ===
    'settling'
      ? 'duration-medium ease-emphasized transition-transform'
      : ''}"
    style={$searchDragPhase === 'idle'
      ? undefined
      : `transform: translateY(${(1 - effectiveProgress) * 850}px)`}
    ontransitionend={(e) => {
      if (
        e.target === e.currentTarget &&
        e.propertyName === 'transform' &&
        $searchDragPhase === 'settling'
      ) {
        searchDragPhase.set('idle');
      }
    }}
    role="dialog"
    aria-label="Search"
  >
    <!-- Top pill, the same one `AppDrawer.svelte` carries, and here it is load-bearing
         rather than decorative. The scrim below is unreachable: it is only exposed in the
         40px band above this sheet's `top-10` edge, and the status bar's own pull-down
         button (`z-60`) covers that band completely. The keyboard is no help either —
         focus starts in the text field, where the `back` keybind is (correctly) not
         dispatched, since Backspace there means "delete a character". Without this pill a
         player who opened search and typed something could only leave by swiping. -->
    <button
      type="button"
      class="absolute top-0 left-0 z-10 flex h-8 w-full cursor-pointer touch-none items-start justify-center pt-3"
      data-gesture-drag
      data-testid="search-top-handle"
      onclick={closeSearch}
      aria-label="Close search"
    >
      <div
        class="duration-medium ease-emphasized h-1 w-8 rounded-full bg-white opacity-80 transition-opacity hover:opacity-100"
      ></div>
    </button>

    <div
      class="bg-surface-container-highest text-on-surface flex h-11 shrink-0 items-center gap-2 rounded-full px-4"
    >
      <SearchIcon class="text-on-surface-variant h-4 w-4" />
      <!-- Placeholder is just "Search": the empty-state line below already names what is
           searchable, and having both say it made the open sheet read as a stutter. -->
      <input
        bind:this={inputRef}
        bind:value={$searchQuery}
        type="text"
        class="text-body-medium placeholder:text-on-surface-variant w-full bg-transparent outline-none"
        placeholder="Search"
        aria-label="Search apps, contacts and messages"
      />
    </div>

    <div class="scrollbar-none flex-1 overflow-y-auto pt-4">
      <!-- The sheet opens on an empty query, so without this it is a full screen of blank
           surface with a cursor blinking at the top — which reads as broken rather than as
           waiting. Says what is searchable, since that is the one thing the player cannot
           guess from an empty list. -->
      {#if !$searchQuery.trim()}
        <p class="text-on-surface-variant text-body-medium px-2 py-6 text-center">
          Search your apps, contacts and messages.
        </p>
      {:else if results.length === 0}
        <p class="text-on-surface-variant text-body-medium px-2 py-6 text-center">
          No results for "{$searchQuery.trim()}"
        </p>
      {/if}

      {#each results as result, index (result.key)}
        {#if index === 0 || results[index - 1].kind !== result.kind}
          <h2 class="text-primary text-label-small px-2 pt-3 pb-1 tracking-wider uppercase">
            {GROUP_LABEL[result.kind]}
          </h2>
        {/if}
        <button
          type="button"
          onclick={() => launch(result)}
          class="hover:bg-surface-container-highest duration-short ease-standard flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
        >
          <!-- An app shows its own tile colour and glyph; a contact or a conversation has
               no icon of its own, so it gets a neutral monogram rather than borrowing some
               other app's identity. -->
          {#if result.kind === 'app'}
            <div
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {result.manifest
                .color} text-white"
            >
              {#if typeof result.manifest.icon === 'string'}
                <img src={result.manifest.icon} alt="" class="h-5 w-5 object-contain" />
              {:else if result.manifest.icon}
                {@const Icon = result.manifest.icon}
                <Icon class="h-5 w-5" />
              {/if}
            </div>
          {:else}
            <div
              class="bg-surface-container-highest text-on-surface-variant text-label-large flex h-9 w-9 shrink-0 items-center justify-center rounded-full uppercase"
            >
              {result.title.trim().charAt(0) || '?'}
            </div>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="text-body-medium truncate">{result.title}</p>
            <p class="text-on-surface-variant text-body-small truncate">{result.subtitle}</p>
          </div>
        </button>
      {/each}
    </div>
  </div>
{/if}
