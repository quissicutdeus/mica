<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    type Note,
    Button,
    ConfirmDialog,
    EmptyState,
    FloatingActionButton,
    ListItem,
    RecentlyDeleted,
    Screen,
    SearchBar,
    Skeleton,
    AddIcon,
    DocumentIcon,
    EditIcon,
    TrashIcon,
    filterByQuery,
    formatDate,
    onAppForeground,
    renderMarkdown,
    useAppAction,
    useAppLevels,
    useDeepLink,
    useDisplay,
    useLocale,
    useSearchProvider,
    registerMessages,
    useScrollDetect,
    type AppProps,
    type RecentlyDeletedItem
  } from '@mica/sdk';
  import NoteEditor from './components/NoteEditor.svelte';
  import TabletRoot from './tablet.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-61: this app's strings, registered by the app itself — the same shape an add-on
  // outside this repository uses, which is the point of it being here and not in a
  // central file. `$t('notes.…')` reads them under the phone's locale.
  registerMessages('notes', { en, de });
  const { t } = useLocale();
  import { useNotes } from './store';

  const { notesStore: notes, getDeletedNotes, restoreNote } = useNotes();
  const notesLoaded = notes.loaded;
  const { busy, run } = useAppAction('notes');

  /**
   * MICA-261. Notes is `core: false`, so the shell has one root to mount for it and the
   * add-on bundle has one entry — the registry's "render `tablet.svelte` instead" path is
   * for core apps. So the branch is here, in the one root, and `tablet.svelte` is a real
   * root behind it rather than a partial: nothing about it has to change when the add-on
   * build learns to ship a second entry (MICA-265).
   *
   * Everything below this line is the phone, unchanged.
   */
  const { device } = useDisplay();

  let { onback, noteId }: AppProps & { noteId?: number } = $props();

  let selectedNote: Note | null = $state(null);
  let draftNote: Note | null = $state(null); // Draft state for editing
  let isEditing = $state(false);
  let isAdding = $state(false);
  let searchQuery = $state('');
  let isScrolled = $state(false);
  let showDeleteConfirm = $state(false);
  let showRecentlyDeleted = $state(false);
  let deletedNotes = $state<Note[]>([]);
  /** What a `noteId` deep link resolved to, for the tablet root to select (MICA-286). */
  let linkedNote = $state<Note | null>(null);

  // New Note State
  let newNote = $state({
    title: '',
    content: ''
  });

  const app = useAppLevels({
    appId: 'notes',
    title: () => $t('notes.title'),
    onback: () => onback(),
    levels: [
      {
        open: () => showDeleteConfirm,
        close: () => (showDeleteConfirm = false)
      },
      {
        open: () => isEditing,
        close: () => (isEditing = false),
        title: () => $t('notes.editNote')
      },
      {
        open: () => !!isAdding,
        close: () => (isAdding = false),
        title: () => $t('notes.newNote')
      },
      {
        open: () => !!selectedNote,
        close: () => {
          selectedNote = null;
          draftNote = null;
        },
        title: () => selectedNote?.title || $t('notes.untitled')
      },
      {
        open: () => showRecentlyDeleted,
        close: () => (showRecentlyDeleted = false),
        title: () => $t('notes.recentlyDeleted')
      }
    ]
  });

  /**
   * "Recently Deleted" (MICA-75-wiring). A fresh read every time it's opened rather
   * than a cached store — the screen is visited rarely enough that this is the right
   * cost, and it means a note deleted moments ago is already there.
   */
  const openRecentlyDeleted = async () => {
    showRecentlyDeleted = true;
    deletedNotes = await getDeletedNotes();
  };

  const recentlyDeletedItems = $derived<RecentlyDeletedItem[]>(
    deletedNotes.map((n) => ({
      id: n.id,
      label: n.title || $t('notes.untitled'),
      preview: n.content,
      deletedAt: n.updated_at
    }))
  );

  const restoreDeletedNote = async (id: string | number) => {
    // `restoreNote` resolves to `false` rather than throwing on a refusal (past the
    // restore window, most likely), so `run` — which only reacts to a thrown error —
    // has to be told about that refusal explicitly.
    const restored = await run(
      async () => {
        if (!(await restoreNote(Number(id)))) {
          throw new Error($t('notes.restoreFailed'));
        }
      },
      { success: $t('notes.restored') }
    );
    if (restored) deletedNotes = deletedNotes.filter((n) => n.id !== id);
  };

  const addNote = async () => {
    if (!newNote.title.trim() && !newNote.content.trim()) return;

    const now = new Date().toISOString();
    const added = await run(
      () =>
        notes.add({
          ...newNote,
          title: newNote.title || $t('notes.untitled'),
          created_at: now,
          updated_at: now
        }),
      { success: $t('notes.saved') }
    );
    if (!added) return;

    isAdding = false;
    newNote = { title: '', content: '' };
  };

  const updateNote = async () => {
    if (!draftNote) return;
    const updated = { ...draftNote, updated_at: new Date().toISOString() };

    if (!(await run(() => notes.update(updated), { success: $t('notes.saved') }))) return;

    selectedNote = updated; // Show the saved copy, and the rendered markdown with it
    isEditing = false;
  };

  const deleteNote = async () => {
    if (!selectedNote) return;
    if (!(await run(() => notes.delete(selectedNote!.id), { success: $t('notes.deleted') })))
      return;

    selectedNote = null;
    draftNote = null;
    showDeleteConfirm = false;
  };

  onAppForeground('notes', () => {
    void notes.load();
  });

  /**
   * Notes in the phone's own search (MICA-286).
   *
   * The shell holds nothing of this app's — it is `core: false`, so its rows live in a
   * sandboxed frame core may not read, and core may not name it either
   * (`sdk/coreBoundary.test.ts`). The needle comes in, the search runs here against the
   * list already loaded, and only the hits go back. `props` is this app's own deep link,
   * which is what makes a hit open the note rather than the app.
   *
   * `filterByQuery` is the same matcher the in-app search bar uses, so a note findable
   * from inside Notes is findable from the home screen and by the same words.
   */
  useSearchProvider('notes', (needle) =>
    filterByQuery($notes, needle, (n) => [n.title, n.content]).map((note) => ({
      id: note.id,
      title: note.title || $t('notes.untitled'),
      // One line: the drawer's row truncates, and a note's own newlines would otherwise
      // be a stretch of blank subtitle rather than the words after them.
      subtitle: note.content.replace(/\s+/g, ' ').trim(),
      props: { noteId: note.id }
    }))
  );

  /**
   * Open the note a search result named.
   *
   * Returns `false` until the list has arrived, which is what keeps a cold open working:
   * the link survives until the note it names exists (see `useDeepLink`).
   */
  useDeepLink('notes', () => {
    if (!noteId) return false;
    const found = $notes.find((n) => n.id === noteId);
    if (!found) return false;
    // The tablet root owns its own selection, so it is handed the note rather than having
    // this root reach into it. On the phone this root is the one rendering.
    if ($device === 'tablet') linkedNote = found;
    else {
      isAdding = false;
      isEditing = false;
      showRecentlyDeleted = false;
      selectedNote = found;
    }
    return true;
  });

  // Collapses the FAB to its icon once the list has scrolled, the same as Contacts and
  // Messages. The detector watches any `.overflow-y-auto` in the app, which here is the
  // note list's own scroller rather than `Screen`'s.
  useScrollDetect((scrolled) => (isScrolled = scrolled));

  const startEditing = () => {
    if (selectedNote) {
      draftNote = { ...selectedNote }; // Create a copy
      isEditing = true;
    }
  };

  // No sort here — the store keeps the list newest-edited-first however it changed, so a
  // note saved while the list is on screen moves immediately rather than at next load.
  let filteredNotes = $derived(filterByQuery($notes, searchQuery, (n) => [n.title, n.content]));
</script>

{#snippet headerActions()}
  <!-- No "add" action here. Creating a note is the bottom-right FAB below (MICA-104),
       which is where every other content-creating app in the phone puts it — and, being
       the shared primitive, is what picks up FAB-wide fixes like MICA-84's. -->
  {#if selectedNote && !isEditing}
    <button
      class="hover:bg-surface-container-high duration-short ease-standard ml-auto rounded-full p-2 transition-colors"
      onclick={startEditing}
      aria-label={$t('notes.edit')}
    >
      <EditIcon />
    </button>
  {:else if !selectedNote && !isAdding && !showRecentlyDeleted}
    <button
      class="hover:bg-surface-container-high duration-short ease-standard ml-auto rounded-full p-2 transition-colors"
      onclick={openRecentlyDeleted}
      title={$t('notes.recentlyDeleted')}
      aria-label={$t('notes.recentlyDeleted')}
    >
      <TrashIcon class="size-icon-md" />
    </button>
  {/if}
{/snippet}

{#snippet fabOverlay()}
  {#if !selectedNote && !isAdding && !showRecentlyDeleted}
    <FloatingActionButton
      label={$t('notes.newNote')}
      collapsed={isScrolled}
      onclick={() => (isAdding = true)}
    >
      {#snippet icon()}
        <AddIcon class="text-on-surface size-icon-sm shrink-0" />
      {/snippet}
    </FloatingActionButton>
  {/if}
{/snippet}

{#if $device === 'tablet'}
  <TabletRoot {onback} initialNote={linkedNote} />
{:else}
  <Screen title={app.title} onback={app.back} actions={headerActions} overlay={fabOverlay}>
    {#if showRecentlyDeleted}
      <!-- No `onpermanentdelete` (MICA-75-wiring): the server ships no hard-delete this
           round — soft-deleted stays soft-deleted forever — so this is restore-only. -->
      <RecentlyDeleted
        items={recentlyDeletedItems}
        onrestore={restoreDeletedNote}
        emptyTitle={$t('notes.noDeleted')}
        emptyDescription={$t('notes.noDeletedHint')}
      />
    {:else if !selectedNote}
      {#if isAdding}
        <div
          class="animate-in fade-in slide-in-from-right bg-surface-container m-2 flex flex-1 flex-col space-y-3 rounded-box p-4"
        >
          <NoteEditor
            bind:title={newNote.title}
            bind:content={newNote.content}
            busy={$busy}
            variant="add"
            autofocusTitle
          />
          <div class="flex space-x-2">
            <Button
              class="flex-1"
              variant="secondary"
              onclick={() => (isAdding = false)}
              disabled={$busy}>{$t('notes.cancel')}</Button
            >
            <Button class="flex-1" onclick={addNote} disabled={$busy}>
              {$busy ? $t('notes.saving') : $t('notes.save')}
            </Button>
          </div>
        </div>
      {:else}
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col space-y-2 overflow-y-auto p-2">
          {#if !isAdding && $notes.length > 0}
            <div class="mb-2">
              <SearchBar
                bind:value={searchQuery}
                placeholder={$t('notes.search')}
                focusRingClass="focus:ring-yellow-500"
              />
            </div>
          {/if}

          {#each filteredNotes as note (note.id)}
            <ListItem
              class="bg-surface-container mb-2 rounded-box p-4"
              onclick={() => (selectedNote = note)}
            >
              <div class="flex w-full flex-col">
                <h2 class="text-on-surface truncate text-lg font-bold">
                  {note.title || $t('notes.untitled')}
                </h2>
                <p class="text-on-surface-variant text-body-medium mt-1 line-clamp-2">
                  {note.content}
                </p>
                <span class="text-on-surface-variant text-body-small mt-2 block">
                  {formatDate(note.updated_at)}
                </span>
              </div>
            </ListItem>
          {/each}
          {#if !$notesLoaded}
            <Skeleton count={4} height="h-20" />
          {:else if filteredNotes.length === 0}
            <EmptyState title={searchQuery ? $t('notes.noMatching') : $t('notes.empty')}>
              {#snippet icon()}
                <DocumentIcon class="h-12 w-12" />
              {/snippet}
            </EmptyState>
          {/if}
        </div>
      {/if}
    {:else}
      <!-- Detailed View / Edit -->
      <div class="bg-surface relative flex min-h-0 flex-1 flex-col">
        {#if isEditing && draftNote}
          <div class="flex h-full flex-col gap-4 p-4">
            <NoteEditor
              bind:title={draftNote.title}
              bind:content={draftNote.content}
              busy={$busy}
              variant="edit"
            />

            <div class="flex gap-2">
              <Button
                class="flex-1"
                variant="danger"
                onclick={() => (showDeleteConfirm = true)}
                disabled={$busy}>{$t('notes.delete')}</Button
              >
              <Button class="flex-1" onclick={updateNote} disabled={$busy}>
                {$busy ? $t('notes.saving') : $t('notes.save')}
              </Button>
            </div>
          </div>
        {:else}
          <div class="no-scrollbar flex-1 overflow-y-auto p-4">
            <div class="prose max-w-none">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(selectedNote.content)}
            </div>
          </div>
        {/if}

        {#if showDeleteConfirm}
          <ConfirmDialog
            title={$t('notes.deleteTitle')}
            message={$t('notes.deleteMessage', {
              title: selectedNote.title || $t('notes.untitled')
            })}
            confirmText={$t('notes.delete')}
            isLoading={$busy}
            oncancel={() => (showDeleteConfirm = false)}
            onconfirm={deleteNote}
          />
        {/if}
      </div>
    {/if}
  </Screen>
{/if}
