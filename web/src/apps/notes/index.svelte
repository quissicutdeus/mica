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
    CheckCircleIcon,
    DocumentIcon,
    EditIcon,
    ListBulletIcon,
    TrashIcon,
    filterByQuery,
    formatDate,
    onAppForeground,
    renderMarkdown,
    useAppAction,
    useAppLevels,
    useLocale,
    registerMessages,
    useScrollDetect,
    useTimer,
    type AppProps,
    type RecentlyDeletedItem,
    fade
  } from '@gphone/sdk';
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
  const { after } = useTimer();

  let { onback }: AppProps = $props();

  let selectedNote: Note | null = $state(null);
  let draftNote: Note | null = $state(null); // Draft state for editing
  let isEditing = $state(false);
  let isAdding = $state(false);
  let searchQuery = $state('');
  let isScrolled = $state(false);
  let showDeleteConfirm = $state(false);
  let showHeadingDropdown = $state(false);
  let textAreaRef: HTMLTextAreaElement | null = $state(null);
  let showRecentlyDeleted = $state(false);
  let deletedNotes = $state<Note[]>([]);

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

  // Collapses the FAB to its icon once the list has scrolled, the same as Contacts and
  // Messages. The detector watches any `.overflow-y-auto` in the app, which here is the
  // note list's own scroller rather than `Screen`'s.
  useScrollDetect((scrolled) => (isScrolled = scrolled));

  const focus = (node: HTMLElement) => {
    node.focus();
  };

  const startEditing = () => {
    if (selectedNote) {
      draftNote = { ...selectedNote }; // Create a copy
      isEditing = true;
    }
  };

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access --
     `textAreaRef` is `HTMLTextAreaElement | null` (svelte-check is clean on this
     function) — typescript-eslint's project service just can't resolve its type
     here, downstream of the `useTimer()`/facet generic lookup used lower in this
     function. Tooling gap, not a real `any`. */
  const insertMarkdown = (prefix: string, suffix: string = '', placeholder: string = '') => {
    if (!textAreaRef) return;

    const start = textAreaRef.selectionStart;
    const end = textAreaRef.selectionEnd;
    const text = textAreaRef.value;
    const selectedText = text.substring(start, end) || placeholder;

    const textBefore = text.substring(0, start);
    const textAfter = text.substring(end);

    const newText = textBefore + prefix + selectedText + suffix + textAfter;

    // Update draft content
    if (draftNote) {
      draftNote.content = newText;
    } else if (isAdding) {
      newNote.content = newText;
    }

    // Restore focus and selection
    after(0, () => {
      if (textAreaRef) {
        textAreaRef.focus();
        const newCursorPos = start + prefix.length + selectedText.length + suffix.length;
        textAreaRef.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  };
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

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
        <input
          class="bg-surface-container-high placeholder-on-surface-variant w-full rounded-chip p-2 text-lg font-bold"
          placeholder={$t('notes.titlePlaceholder')}
          bind:value={newNote.title}
          use:focus
          disabled={$busy}
        />
        <div class="relative min-h-0 flex-1">
          <textarea
            class="no-scrollbar bg-surface-container-high placeholder-on-surface-variant h-full w-full resize-none rounded-chip p-2 pb-12"
            placeholder={$t('notes.contentPlaceholder')}
            bind:this={textAreaRef}
            bind:value={newNote.content}
            disabled={$busy}></textarea>
          <!-- Markdown Toolbar -->
          <div
            class="border-outline bg-surface-container shadow-elevation-3 absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-box border p-1"
          >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded-chip p-2 font-bold"
              onclick={() => insertMarkdown('**', '**', 'bold')}
              title={$t('notes.bold')}>B</button
            >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded-chip p-2 font-serif italic"
              onclick={() => insertMarkdown('*', '*', 'italic')}
              title={$t('notes.italic')}>I</button
            >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded-chip p-2"
              onclick={() => insertMarkdown('- ', '', 'item')}
              title={$t('notes.insertList')}
            >
              <ListBulletIcon />
            </button>
            <button
              class="text-on-surface hover:bg-surface-container-high rounded-chip p-2"
              onclick={() => insertMarkdown('- [ ] ', '', 'task')}
              title={$t('notes.insertTask')}
            >
              <CheckCircleIcon />
            </button>
            <div class="relative">
              <button
                class="text-on-surface hover:bg-surface-container-high rounded-chip p-2 font-bold"
                onclick={() => (showHeadingDropdown = !showHeadingDropdown)}
                title={$t('notes.insertHeading')}>H</button
              >
              {#if showHeadingDropdown}
                <div
                  class="border-outline-variant bg-surface-container shadow-elevation-4 absolute right-0 bottom-full mb-2 flex min-w-[3rem] flex-col overflow-hidden rounded-box border"
                  transition:fade={{ duration: 100 }}
                >
                  {#each [1, 2, 3, 4, 5, 6] as level (level)}
                    <button
                      class="border-outline-variant text-on-surface hover:bg-surface-container-high text-body-medium border-b px-3 py-2 text-left last:border-0"
                      onclick={() => {
                        insertMarkdown('#'.repeat(level) + ' ', '', `Heading ${level}`);
                        showHeadingDropdown = false;
                      }}
                      title={$t('notes.insertHeadingLevel', { level })}
                    >
                      H{level}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
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
          <input
            class="border-outline-variant bg-surface-container placeholder-on-surface-variant w-full rounded-chip border p-2 text-xl font-bold focus:border-yellow-500 focus:outline-none"
            bind:value={draftNote.title}
            placeholder={$t('notes.titlePlaceholder')}
            disabled={$busy}
          />
          <div class="relative min-h-0 flex-1">
            <textarea
              class="no-scrollbar border-outline-variant bg-surface-container placeholder-on-surface-variant text-body-medium h-full w-full resize-none rounded-chip border p-2 pb-12 font-mono focus:border-yellow-500 focus:outline-none"
              bind:this={textAreaRef}
              bind:value={draftNote.content}
              placeholder={$t('notes.markdownPlaceholder')}
              disabled={$busy}></textarea>
            <!-- Markdown Toolbar -->
            <div
              class="border-outline bg-surface-container-high shadow-elevation-3 absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-box border p-1 backdrop-blur"
            >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded-chip p-2 font-bold"
                onclick={() => insertMarkdown('**', '**', 'bold')}
                title={$t('notes.bold')}>B</button
              >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded-chip p-2 font-serif italic"
                onclick={() => insertMarkdown('*', '*', 'italic')}
                title={$t('notes.italic')}>I</button
              >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded-chip p-2"
                onclick={() => insertMarkdown('- ', '', 'item')}
                title={$t('notes.insertList')}
              >
                <ListBulletIcon />
              </button>
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded-chip p-2"
                onclick={() => insertMarkdown('- [ ] ', '', 'task')}
                title={$t('notes.insertTask')}
              >
                <CheckCircleIcon />
              </button>
              <div class="relative">
                <button
                  class="text-on-surface hover:bg-surface-container-highest rounded-chip p-2 font-bold"
                  onclick={() => (showHeadingDropdown = !showHeadingDropdown)}
                  title={$t('notes.insertHeading')}>H</button
                >
                {#if showHeadingDropdown}
                  <div
                    class="border-outline-variant bg-surface-container shadow-elevation-4 absolute right-0 bottom-full mb-2 flex min-w-[3rem] flex-col overflow-hidden rounded-box border"
                    transition:fade={{ duration: 100 }}
                  >
                    {#each [1, 2, 3, 4, 5, 6] as level (level)}
                      <button
                        class="border-outline-variant text-on-surface hover:bg-surface-container-high text-body-medium border-b px-3 py-2 text-left last:border-0"
                        onclick={() => {
                          insertMarkdown('#'.repeat(level) + ' ', '', `Heading ${level}`);
                          showHeadingDropdown = false;
                        }}
                        title={$t('notes.insertHeadingLevel', { level })}
                      >
                        H{level}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </div>

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
          message={$t('notes.deleteMessage', { title: selectedNote.title || $t('notes.untitled') })}
          confirmText={$t('notes.delete')}
          isLoading={$busy}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteNote}
        />
      {/if}
    </div>
  {/if}
</Screen>
