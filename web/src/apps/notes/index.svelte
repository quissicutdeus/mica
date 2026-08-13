<script lang="ts">
  import {
    type Note,
    Button,
    ConfirmDialog,
    EmptyState,
    ListItem,
    Screen,
    SearchBar,
    Skeleton,
    AddIcon,
    CheckCircleIcon,
    DocumentIcon,
    EditIcon,
    ListBulletIcon,
    filterByQuery,
    formatDate,
    onAppForeground,
    renderMarkdown,
    useAppAction,
    useAppLevels,
    useTimer,
    type AppProps
  } from '@gphone/sdk';
  import { useNotes } from './store';

  const { notesStore: notes } = useNotes();
  const notesLoaded = notes.loaded;
  const { busy, run } = useAppAction('notes');
  const { after } = useTimer();
  import { fade } from 'svelte/transition';

  let { onback }: AppProps = $props();

  let selectedNote: Note | null = $state(null);
  let draftNote: Note | null = $state(null); // Draft state for editing
  let isEditing = $state(false);
  let isAdding = $state(false);
  let searchQuery = $state('');
  let showDeleteConfirm = $state(false);
  let showHeadingDropdown = $state(false);
  let textAreaRef: HTMLTextAreaElement | null = $state(null);

  // New Note State
  let newNote = $state({
    title: '',
    content: ''
  });

  const app = useAppLevels({
    appId: 'notes',
    title: 'Notes',
    onback: () => onback(),
    levels: [
      {
        open: () => showDeleteConfirm,
        close: () => (showDeleteConfirm = false)
      },
      {
        open: () => isEditing,
        close: () => (isEditing = false),
        title: 'Edit Note'
      },
      {
        open: () => !!isAdding,
        close: () => (isAdding = false),
        title: 'New Note'
      },
      {
        open: () => !!selectedNote,
        close: () => {
          selectedNote = null;
          draftNote = null;
        },
        title: () => selectedNote?.title || 'Untitled'
      }
    ]
  });

  const addNote = async () => {
    if (!newNote.title.trim() && !newNote.content.trim()) return;

    const now = new Date().toISOString();
    const added = await run(
      () =>
        notes.add({
          ...newNote,
          title: newNote.title || 'Untitled',
          created_at: now,
          updated_at: now
        }),
      { success: 'Note saved' }
    );
    if (!added) return;

    isAdding = false;
    newNote = { title: '', content: '' };
  };

  const updateNote = async () => {
    if (!draftNote) return;
    const updated = { ...draftNote, updated_at: new Date().toISOString() };

    if (!(await run(() => notes.update(updated), { success: 'Note saved' }))) return;

    selectedNote = updated; // Show the saved copy, and the rendered markdown with it
    isEditing = false;
  };

  const deleteNote = async () => {
    if (!selectedNote) return;
    if (!(await run(() => notes.delete(selectedNote!.id), { success: 'Note deleted' }))) return;

    selectedNote = null;
    draftNote = null;
    showDeleteConfirm = false;
  };

  onAppForeground('notes', () => {
    void notes.load();
  });

  const focus = (node: HTMLElement) => {
    node.focus();
  };

  const startEditing = () => {
    if (selectedNote) {
      draftNote = { ...selectedNote }; // Create a copy
      isEditing = true;
    }
  };

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

  // No sort here — the store keeps the list newest-edited-first however it changed, so a
  // note saved while the list is on screen moves immediately rather than at next load.
  let filteredNotes = $derived(filterByQuery($notes, searchQuery, (n) => [n.title, n.content]));
</script>

{#snippet headerActions()}
  {#if !selectedNote && !isAdding}
    <button
      class="hover:bg-surface-container-high ml-auto rounded-full p-2 transition-colors"
      onclick={() => (isAdding = true)}
      aria-label="Add note"
    >
      <AddIcon />
    </button>
  {:else if selectedNote && !isEditing}
    <button
      class="hover:bg-surface-container-high ml-auto rounded-full p-2 transition-colors"
      onclick={startEditing}
      aria-label="Edit note"
    >
      <EditIcon />
    </button>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions}>
  {#if !selectedNote}
    {#if isAdding}
      <div
        class="animate-in fade-in slide-in-from-right bg-surface-container m-2 flex h-[calc(100%-1rem)] flex-col space-y-3 rounded-lg p-4"
      >
        <input
          class="bg-surface-container-high placeholder-on-surface-variant w-full rounded p-2 text-lg font-bold"
          placeholder="Title"
          bind:value={newNote.title}
          use:focus
          disabled={$busy}
        />
        <div class="relative min-h-0 flex-1">
          <textarea
            class="no-scrollbar bg-surface-container-high placeholder-on-surface-variant h-full w-full resize-none rounded p-2 pb-12"
            placeholder="Content (Markdown supported)"
            bind:this={textAreaRef}
            bind:value={newNote.content}
            disabled={$busy}></textarea>
          <!-- Markdown Toolbar -->
          <div
            class="border-outline bg-surface-container absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-lg border p-1 shadow-lg"
          >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded p-2 font-bold"
              onclick={() => insertMarkdown('**', '**', 'bold')}
              title="Bold">B</button
            >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded p-2 font-serif italic"
              onclick={() => insertMarkdown('*', '*', 'italic')}
              title="Italic">I</button
            >
            <button
              class="text-on-surface hover:bg-surface-container-high rounded p-2"
              onclick={() => insertMarkdown('- ', '', 'item')}
              title="Insert List Item"
            >
              <ListBulletIcon />
            </button>
            <button
              class="text-on-surface hover:bg-surface-container-high rounded p-2"
              onclick={() => insertMarkdown('- [ ] ', '', 'task')}
              title="Insert Task Item"
            >
              <CheckCircleIcon />
            </button>
            <div class="relative">
              <button
                class="text-on-surface hover:bg-surface-container-high rounded p-2 font-bold"
                onclick={() => (showHeadingDropdown = !showHeadingDropdown)}
                title="Insert Heading">H</button
              >
              {#if showHeadingDropdown}
                <div
                  class="border-outline-variant bg-surface-container absolute right-0 bottom-full mb-2 flex min-w-[3rem] flex-col overflow-hidden rounded-lg border shadow-xl"
                  transition:fade={{ duration: 100 }}
                >
                  {#each [1, 2, 3, 4, 5, 6] as level}
                    <button
                      class="border-outline-variant text-on-surface hover:bg-surface-container-high border-b px-3 py-2 text-left text-sm font-bold last:border-0"
                      onclick={() => {
                        insertMarkdown('#'.repeat(level) + ' ', '', `Heading ${level}`);
                        showHeadingDropdown = false;
                      }}
                      title="Insert Heading {level}"
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
            disabled={$busy}
          >
            Cancel
          </Button>
          <Button class="flex-1" onclick={addNote} disabled={$busy}>
            {$busy ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    {:else}
      <div class="no-scrollbar flex h-full flex-col space-y-2 overflow-y-auto p-2">
        {#if !isAdding && $notes.length > 0}
          <div class="mb-2">
            <SearchBar
              bind:value={searchQuery}
              placeholder="Search notes..."
              focusRingClass="focus:ring-yellow-500"
            />
          </div>
        {/if}

        {#each filteredNotes as note (note.id)}
          <ListItem
            class="bg-surface-container mb-2 rounded-lg p-4 shadow"
            onclick={() => (selectedNote = note)}
          >
            <div class="flex w-full flex-col">
              <h3 class="truncate text-lg font-bold text-yellow-500">
                {note.title || 'Untitled'}
              </h3>
              <p class="text-on-surface-variant mt-1 line-clamp-2 text-sm">
                {note.content}
              </p>
              <span class="text-outline mt-2 block text-xs">
                {formatDate(note.updated_at)}
              </span>
            </div>
          </ListItem>
        {/each}
        {#if !$notesLoaded}
          <Skeleton count={4} height="h-20" />
        {:else if filteredNotes.length === 0}
          <EmptyState title={searchQuery ? 'No matching notes' : 'No notes yet'}>
            {#snippet icon()}
              <DocumentIcon class="h-12 w-12" />
            {/snippet}
          </EmptyState>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- Detailed View / Edit -->
    <div class="bg-surface relative flex h-full flex-col">
      {#if isEditing && draftNote}
        <div class="flex h-full flex-col gap-4 p-4">
          <input
            class="border-outline-variant bg-surface-container placeholder-on-surface-variant w-full rounded border p-2 text-xl font-bold focus:border-yellow-500 focus:outline-none"
            bind:value={draftNote.title}
            placeholder="Title"
            disabled={$busy}
          />
          <div class="relative min-h-0 flex-1">
            <textarea
              class="no-scrollbar border-outline-variant bg-surface-container placeholder-on-surface-variant h-full w-full resize-none rounded border p-2 pb-12 font-mono text-sm focus:border-yellow-500 focus:outline-none"
              bind:this={textAreaRef}
              bind:value={draftNote.content}
              placeholder="Markdown content..."
              disabled={$busy}></textarea>
            <!-- Markdown Toolbar -->
            <div
              class="border-outline bg-surface-container-high absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-lg border p-1 shadow-lg backdrop-blur"
            >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded p-2 font-bold"
                onclick={() => insertMarkdown('**', '**', 'bold')}
                title="Bold">B</button
              >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded p-2 font-serif italic"
                onclick={() => insertMarkdown('*', '*', 'italic')}
                title="Italic">I</button
              >
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded p-2"
                onclick={() => insertMarkdown('- ', '', 'item')}
                title="Insert List Item"
              >
                <ListBulletIcon />
              </button>
              <button
                class="text-on-surface hover:bg-surface-container-highest rounded p-2"
                onclick={() => insertMarkdown('- [ ] ', '', 'task')}
                title="Insert Task Item"
              >
                <CheckCircleIcon />
              </button>
              <div class="relative">
                <button
                  class="text-on-surface hover:bg-surface-container-highest rounded p-2 font-bold"
                  onclick={() => (showHeadingDropdown = !showHeadingDropdown)}
                  title="Insert Heading">H</button
                >
                {#if showHeadingDropdown}
                  <div
                    class="border-outline-variant bg-surface-container absolute right-0 bottom-full mb-2 flex min-w-[3rem] flex-col overflow-hidden rounded-lg border shadow-xl"
                    transition:fade={{ duration: 100 }}
                  >
                    {#each [1, 2, 3, 4, 5, 6] as level}
                      <button
                        class="border-outline-variant text-on-surface hover:bg-surface-container-high border-b px-3 py-2 text-left text-sm font-bold last:border-0"
                        onclick={() => {
                          insertMarkdown('#'.repeat(level) + ' ', '', `Heading ${level}`);
                          showHeadingDropdown = false;
                        }}
                        title="Insert Heading {level}"
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
              disabled={$busy}
            >
              Delete
            </Button>
            <Button class="flex-1" onclick={updateNote} disabled={$busy}>
              {$busy ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      {:else}
        <div class="no-scrollbar flex-1 overflow-y-auto p-4">
          <div class="prose prose-invert prose-sm max-w-none">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderMarkdown(selectedNote.content)}
          </div>
        </div>
      {/if}

      {#if showDeleteConfirm}
        <ConfirmDialog
          title="Delete Note?"
          message={`Are you sure you want to delete "${selectedNote.title || 'Untitled'}"? This action cannot be undone.`}
          confirmText="Delete"
          isLoading={$busy}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteNote}
        />
      {/if}
    </div>
  {/if}
</Screen>
