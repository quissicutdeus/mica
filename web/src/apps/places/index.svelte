<script lang="ts">
  import {
    EmptyState,
    Screen,
    Skeleton,
    Button,
    ConfirmDialog,
    FloatingActionButton,
    LocationIcon,
    AddIcon,
    EditIcon,
    TrashIcon,
    formatDate,
    useAppLevels,
    useAppAction,
    useLocation,
    useMedia,
    onAppForeground,
    type AppProps
  } from '@gphone/sdk';
  import type { SavedPlace, MediaPreview } from '@gphone/shared/types';
  import { useSavedPlaces } from './store';

  let { onback }: AppProps = $props();

  const {
    savedPlacesStore: places,
    addSavedPlace,
    renameSavedPlace,
    deleteSavedPlace
  } = useSavedPlaces();
  const placesLoaded = places.loaded;
  const { media } = useMedia();
  const { shareLocation, setWaypoint } = useLocation();
  const { busy, run } = useAppAction('places');

  let isAdding = $state(false);
  let renamingPlace: SavedPlace | null = $state(null);
  let deletingPlace: SavedPlace | null = $state(null);

  /** Prefilled from `shareLocation`'s own street-name resolve — see the doc below. */
  let draft = $state<{ name: string; street_label: string; x: number; y: number; z: number }>({
    name: '',
    street_label: '',
    x: 0,
    y: 0,
    z: 0
  });

  const app = useAppLevels({
    appId: 'places',
    title: 'Places',
    onback: () => onback(),
    levels: [
      {
        open: () => !!deletingPlace,
        close: () => (deletingPlace = null)
      },
      {
        open: () => !!renamingPlace,
        close: () => (renamingPlace = null),
        title: 'Rename Place'
      },
      {
        open: () => isAdding,
        close: () => (isAdding = false),
        title: 'Save This Place'
      }
    ]
  });

  /**
   * Recently shared locations, reusing the media service's own model rather than a second
   * one (MICA-65) — a `kind: 'location'` row is exactly what `shareLocation` below (and
   * Messages' own share-location action) already creates. Scoped to this player's own
   * shares, which is all `getMedia` can answer: it is owner-scoped, the same as the Media
   * app's gallery.
   */
  let recentLocations = $derived($media.filter((item) => item.kind === 'location').slice(0, 10));

  const parseLocation = (item: MediaPreview): { x: number; y: number } | null => {
    if (!item.data) return null;
    try {
      const parsed = JSON.parse(item.data) as unknown;
      const { x, y } = (parsed ?? {}) as { x?: unknown; y?: unknown };
      return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
    } catch {
      return null;
    }
  };

  const handleSetWaypointFrom = async (x: number, y: number) => {
    await run(() => setWaypoint(x, y), {
      success: 'Waypoint set',
      error: 'Could not set waypoint'
    });
  };

  /** The standalone action (ticket item 2) — no form, no picking a conversation. */
  const handleShareCurrentLocation = async () => {
    await run(
      async () => {
        await shareLocation();
        await media.load();
      },
      { success: 'Location shared', error: 'Could not share your location' }
    );
  };

  /**
   * Opens the add-place form, prefilled with the player's current position and street
   * name — resolved the same way `shareLocation` already resolves one (client-only native,
   * server re-reads the position independently), reused rather than duplicated per the
   * ticket. The side effect is real: this also deposits a `kind: 'location'` row, the same
   * one "Share My Location" above creates, so saving a place also logs a location share.
   * That is a deliberate reuse of the one client-side resolve path this ticket allows
   * rather than a client change of its own — see the app's report for the trade-off.
   */
  const openAddPlace = async () => {
    // `run()` only ever resolves to whether the work succeeded, never the work's own
    // return value (`useAppAction`'s own doc comment) — so the row `shareLocation` hands
    // back is captured from the closure instead of from `run`'s result.
    let shared: MediaPreview | undefined;
    const ok = await run(
      async () => {
        const { media: row } = await shareLocation();
        shared = row;
        await media.load();
      },
      { error: 'Could not read your current location' }
    );
    if (!ok || !shared) return;

    const at = parseLocation(shared);
    if (!at) return;

    draft = {
      name: shared.alt_text || '',
      street_label: shared.alt_text || '',
      x: at.x,
      y: at.y,
      z: 0
    };
    isAdding = true;
  };

  const saveNewPlace = async () => {
    if (!draft.name.trim()) return;
    const ok = await run(
      () =>
        addSavedPlace({
          name: draft.name.trim(),
          street_label: draft.street_label || undefined,
          x: draft.x,
          y: draft.y,
          z: draft.z
        }),
      { success: 'Place saved' }
    );
    if (!ok) return;
    isAdding = false;
  };

  let renameDraft = $state('');

  const startRename = (place: SavedPlace) => {
    renamingPlace = place;
    renameDraft = place.name;
  };

  const confirmRename = async () => {
    if (!renamingPlace || !renameDraft.trim()) return;
    const ok = await run(() => renameSavedPlace(renamingPlace!, renameDraft.trim()), {
      success: 'Place renamed'
    });
    if (ok) renamingPlace = null;
  };

  const confirmDelete = async () => {
    if (!deletingPlace) return;
    await run(() => deleteSavedPlace(deletingPlace!.id), { success: 'Place deleted' });
    deletingPlace = null;
  };

  onAppForeground('places', () => {
    void media.load();
    void places.load();
  });
</script>

{#snippet headerActions()}
  <button
    type="button"
    class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard ml-auto rounded-full p-2 transition-colors"
    onclick={handleShareCurrentLocation}
    disabled={$busy}
    title="Share my current location"
    aria-label="Share my current location"
  >
    <LocationIcon class="size-icon-sm" />
  </button>
{/snippet}

{#snippet fabOverlay()}
  {#if !isAdding && !renamingPlace && !deletingPlace}
    <FloatingActionButton label="Save Place" onclick={openAddPlace}>
      {#snippet icon()}
        <AddIcon class="text-on-surface size-icon-sm shrink-0" />
      {/snippet}
    </FloatingActionButton>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={fabOverlay}>
  {#if isAdding}
    <div
      class="animate-in fade-in slide-in-from-right bg-surface-container m-2 flex flex-col space-y-3 rounded-lg p-4"
    >
      <p class="text-on-surface-variant text-body-small">
        Saved from your current position. Give it a name — the street below is only a starting
        guess.
      </p>
      <input
        class="bg-surface-container-high placeholder-on-surface-variant text-on-surface w-full rounded p-2 text-lg font-bold"
        placeholder="Name (e.g. Home, The Garage)"
        maxlength="50"
        bind:value={draft.name}
        disabled={$busy}
      />
      <input
        class="bg-surface-container-high placeholder-on-surface-variant text-on-surface text-body-medium w-full rounded p-2"
        placeholder="Street label"
        maxlength="255"
        bind:value={draft.street_label}
        disabled={$busy}
      />
      <div class="flex space-x-2">
        <Button
          class="flex-1"
          variant="secondary"
          onclick={() => (isAdding = false)}
          disabled={$busy}
        >
          Cancel
        </Button>
        <Button class="flex-1" onclick={saveNewPlace} disabled={$busy || !draft.name.trim()}>
          {$busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  {:else if renamingPlace}
    <div
      class="animate-in fade-in slide-in-from-right bg-surface-container m-2 flex flex-col space-y-3 rounded-lg p-4"
    >
      <input
        class="bg-surface-container-high placeholder-on-surface-variant text-on-surface w-full rounded p-2 text-lg font-bold"
        placeholder="Name"
        maxlength="50"
        bind:value={renameDraft}
        disabled={$busy}
      />
      <div class="flex space-x-2">
        <Button
          class="flex-1"
          variant="secondary"
          onclick={() => (renamingPlace = null)}
          disabled={$busy}
        >
          Cancel
        </Button>
        <Button class="flex-1" onclick={confirmRename} disabled={$busy || !renameDraft.trim()}>
          {$busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  {:else}
    <div class="no-scrollbar flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-3">
      <section>
        <h2 class="text-on-surface-variant text-body-small mb-1.5 px-1 tracking-wide uppercase">
          Saved Places
        </h2>
        {#if !$placesLoaded}
          <Skeleton count={2} height="h-16" />
        {:else if $places.length === 0}
          <EmptyState title="No saved places yet">
            {#snippet icon()}
              <LocationIcon class="h-10 w-10" />
            {/snippet}
          </EmptyState>
        {:else}
          <div class="space-y-2">
            {#each $places as place (place.id)}
              <div class="bg-surface-container rounded-lg p-3.5">
                <div class="flex w-full items-center gap-3">
                  <LocationIcon class="text-primary size-icon-md shrink-0" />
                  <div class="min-w-0 flex-1">
                    <h3 class="text-on-surface truncate font-bold">{place.name}</h3>
                    {#if place.street_label}
                      <p class="text-on-surface-variant text-body-small truncate">
                        {place.street_label}
                      </p>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard rounded-full p-1.5 transition-colors"
                      onclick={() => handleSetWaypointFrom(place.x, place.y)}
                      disabled={$busy}
                      title="Set waypoint"
                      aria-label={`Set waypoint to ${place.name}`}
                    >
                      <LocationIcon class="size-icon-sm" />
                    </button>
                    <button
                      type="button"
                      class="text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard rounded-full p-1.5 transition-colors"
                      onclick={() => startRename(place)}
                      disabled={$busy}
                      title="Rename"
                      aria-label={`Rename ${place.name}`}
                    >
                      <EditIcon class="size-icon-sm" />
                    </button>
                    <button
                      type="button"
                      class="text-on-surface-variant hover:bg-surface-container-high hover:text-error duration-short ease-standard rounded-full p-1.5 transition-colors"
                      onclick={() => (deletingPlace = place)}
                      disabled={$busy}
                      title="Delete"
                      aria-label={`Delete ${place.name}`}
                    >
                      <TrashIcon class="size-icon-sm" />
                    </button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section>
        <h2 class="text-on-surface-variant text-body-small mb-1.5 px-1 tracking-wide uppercase">
          Recently Shared
        </h2>
        {#if recentLocations.length === 0}
          <EmptyState title="No shared locations yet">
            {#snippet icon()}
              <LocationIcon class="h-10 w-10" />
            {/snippet}
          </EmptyState>
        {:else}
          <div class="space-y-2">
            {#each recentLocations as item (item.id)}
              {@const at = parseLocation(item)}
              <div class="bg-surface-container rounded-lg p-3.5">
                <div class="flex w-full items-center gap-3">
                  <LocationIcon class="text-on-surface-variant size-icon-md shrink-0" />
                  <div class="min-w-0 flex-1">
                    <h3 class="text-on-surface truncate font-bold">
                      {item.alt_text || 'Shared location'}
                    </h3>
                    <p class="text-on-surface-variant text-body-small">
                      {formatDate(item.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard shrink-0 rounded-full p-1.5 transition-colors disabled:opacity-40"
                    onclick={() => at && handleSetWaypointFrom(at.x, at.y)}
                    disabled={$busy || !at}
                    title="Set waypoint"
                    aria-label={`Set waypoint to ${item.alt_text || 'shared location'}`}
                  >
                    <LocationIcon class="size-icon-sm" />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}

  {#if deletingPlace}
    <ConfirmDialog
      title="Delete place?"
      message={`Remove "${deletingPlace.name}" from your saved places? This cannot be undone.`}
      confirmText="Delete"
      isLoading={$busy}
      oncancel={() => (deletingPlace = null)}
      onconfirm={confirmDelete}
    />
  {/if}
</Screen>
