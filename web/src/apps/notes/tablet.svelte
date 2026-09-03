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
    RecentlyDeleted,
    Screen,
    SearchBar,
    Skeleton,
    DocumentIcon,
    EditIcon,
    TrashIcon,
    filterByQuery,
    formatDate,
    onAppForeground,
    renderMarkdown,
    useAppAction,
    useAppLevels,
    useLocale,
    registerMessages,
    type AppProps,
    type RecentlyDeletedItem
  } from '@gos/sdk';
  import NoteEditor from './components/NoteEditor.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  /**
   * Notes in the tablet frame (MICA-261): the list on the left, the note on the right,
   * both on screen at once.
   *
   * `registerMessages` is idempotent and is called here as well as in `index.svelte` on
   * purpose. Today the phone root is what renders this one — Notes is `core: false`, so
   * the add-on bundle has a single entry — but the registry mounts a core app's
   * `tablet.svelte` directly, and this file should not depend on which of the two got
   * there first.
   */
  registerMessages('notes', { en, de });
  const { t } = useLocale();
  import { useNotes } from './store';

  const { notesStore: notes, getDeletedNotes, restoreNote } = useNotes();
  const notesLoaded = notes.loaded;
  const { busy, run } = useAppAction('notes');

  let { onback }: AppProps = $props();

  let selectedNote: Note | null = $state(null);
  let draftNote: Note | null = $state(null);
  let isEditing = $state(false);
  let isAdding = $state(false);
  let searchQuery = $state('');
  let showDeleteConfirm = $state(false);
  let showRecentlyDeleted = $state(false);
  let deletedNotes = $state<Note[]>([]);

  let newNote = $state({ title: '', content: '' });

  /**
   * The phone's ladder without the `selectedNote` rung.
   *
   * On the phone, opening a note replaces the list, so Back has somewhere to go. Here the
   * list never leaves the screen: selecting a note changes what the right pane draws and
   * nothing else, which is not a level, and making it one would give the tablet a Back
   * that appears to do nothing. Back at the top of this ladder leaves the app.
   */
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
        open: () => showRecentlyDeleted,
        close: () => (showRecentlyDeleted = false),
        title: () => $t('notes.recentlyDeleted')
      }
    ]
  });

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
    // Same refusal handling as the phone root: `restoreNote` resolves `false` rather than
    // throwing, and `run` only reacts to a throw.
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

  const startAdding = () => {
    showRecentlyDeleted = false;
    isEditing = false;
    draftNote = null;
    newNote = { title: '', content: '' };
    isAdding = true;
  };

  const startEditing = () => {
    if (!selectedNote) return;
    draftNote = { ...selectedNote };
    isEditing = true;
  };

  const selectNote = (note: Note) => {
    isAdding = false;
    isEditing = false;
    draftNote = null;
    showRecentlyDeleted = false;
    selectedNote = note;
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

    selectedNote = updated;
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

  // No sort here — the store keeps the list newest-edited-first (see `store.ts`).
  let filteredNotes = $derived(filterByQuery($notes, searchQuery, (n) => [n.title, n.content]));
</script>

<Screen title={app.title} onback={app.back}>
  <div class="flex min-h-0 flex-1">
    <!-- List pane -->
    <div class="border-outline-variant flex min-h-0 w-72 shrink-0 flex-col border-r">
      <div class="flex flex-col gap-2 p-3">
        <SearchBar
          bind:value={searchQuery}
          placeholder={$t('notes.search')}
          focusRingClass="focus:ring-yellow-500"
        />
        <Button class="w-full" onclick={startAdding} disabled={$busy}>
          {$t('notes.newNote')}
        </Button>
      </div>

      <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {#each filteredNotes as note (note.id)}
          <button
            class="hover:bg-surface-hover active:bg-surface-pressed duration-short ease-standard mb-2 flex w-full flex-col rounded-box p-3 text-left transition-colors"
            class:bg-surface-container={selectedNote?.id === note.id}
            aria-pressed={selectedNote?.id === note.id}
            onclick={() => selectNote(note)}
          >
            <span class="text-on-surface w-full truncate text-lg font-bold">
              {note.title || $t('notes.untitled')}
            </span>
            <span class="text-on-surface-variant text-body-medium mt-1 line-clamp-2">
              {note.content}
            </span>
            <span class="text-on-surface-variant text-body-small mt-2 block">
              {formatDate(note.updated_at)}
            </span>
          </button>
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

      <!-- Anchored to the bottom of the pane, so it clears the home indicator. -->
      <div class="border-outline-variant shrink-0 border-t p-3 pb-home-indicator">
        <button
          class="hover:bg-surface-hover duration-short ease-standard flex w-full items-center gap-2 rounded-box p-2 text-left transition-colors"
          class:bg-surface-container={showRecentlyDeleted}
          aria-pressed={showRecentlyDeleted}
          onclick={openRecentlyDeleted}
        >
          <TrashIcon class="size-icon-md" />
          <span class="text-on-surface text-body-medium">{$t('notes.recentlyDeleted')}</span>
        </button>
      </div>
    </div>

    <!-- Detail pane -->
    <div data-testid="notes-detail" class="bg-surface relative flex min-h-0 flex-1 flex-col">
      {#if showRecentlyDeleted}
        <!-- Restore-only, exactly as on the phone: the server ships no hard delete. -->
        <RecentlyDeleted
          items={recentlyDeletedItems}
          onrestore={restoreDeletedNote}
          emptyTitle={$t('notes.noDeleted')}
          emptyDescription={$t('notes.noDeletedHint')}
        />
      {:else if isAdding}
        <div class="flex min-h-0 flex-1 flex-col gap-4 p-4 pb-home-indicator">
          <NoteEditor
            bind:title={newNote.title}
            bind:content={newNote.content}
            busy={$busy}
            variant="edit"
            autofocusTitle
          />
          <div class="flex gap-2">
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
      {:else if isEditing && draftNote}
        <div class="flex min-h-0 flex-1 flex-col gap-4 p-4 pb-home-indicator">
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
            <Button
              class="flex-1"
              variant="secondary"
              onclick={() => {
                isEditing = false;
                draftNote = null;
              }}
              disabled={$busy}>{$t('notes.cancel')}</Button
            >
            <Button class="flex-1" onclick={updateNote} disabled={$busy}>
              {$busy ? $t('notes.saving') : $t('notes.save')}
            </Button>
          </div>
        </div>
      {:else if selectedNote}
        <div class="border-outline-variant flex shrink-0 items-center gap-2 border-b p-4">
          <h2 class="text-on-surface truncate text-xl font-bold">
            {selectedNote.title || $t('notes.untitled')}
          </h2>
          <span class="text-on-surface-variant text-body-small ml-auto">
            {formatDate(selectedNote.updated_at)}
          </span>
          <button
            class="hover:bg-surface-container-high duration-short ease-standard rounded-full p-2 transition-colors"
            onclick={startEditing}
            aria-label={$t('notes.edit')}
          >
            <EditIcon />
          </button>
        </div>
        <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto p-4 pb-home-indicator">
          <div class="prose max-w-none">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderMarkdown(selectedNote.content)}
          </div>
        </div>
      {:else}
        <EmptyState title={$t('notes.selectNote')} description={$t('notes.selectNoteHint')}>
          {#snippet icon()}
            <DocumentIcon class="h-12 w-12" />
          {/snippet}
        </EmptyState>
      {/if}

      {#if showDeleteConfirm && selectedNote}
        <ConfirmDialog
          title={$t('notes.deleteTitle')}
          message={$t('notes.deleteMessage', { title: selectedNote.title || $t('notes.untitled') })}
          confirmText={$t('notes.delete')}
          isLoading={$busy}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteNote}
        />
      {/if}
    </div>
  </div>
</Screen>
