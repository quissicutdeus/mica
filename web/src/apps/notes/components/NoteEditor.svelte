<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { CheckCircleIcon, ListBulletIcon, fade, useLocale, useTimer } from '@gphone/sdk';

  /**
   * Notes' markdown editor: the title field, the content textarea, and the toolbar that
   * writes markdown into it (MICA-261).
   *
   * It was written twice in `index.svelte` — once for a new note and once for an edit —
   * with the same `insertMarkdown`, the same six-level heading dropdown and two
   * near-identical sets of classes. The tablet root wants a third copy, which is one
   * copy too many: this is the one, and `variant` carries the only thing that actually
   * differed between them, which is how the fields are painted.
   *
   * The strings are `notes.*` and the app registers them (`registerMessages('notes', …)`
   * in both roots), so this reads them through `$t` exactly as its parents do.
   */
  interface Props {
    /** The note's title. Bindable — the parent owns the draft. */
    title: string;
    /** The note's markdown body. Bindable; the toolbar writes through it. */
    content: string;
    /** Whether a save is in flight, which disables both fields. */
    busy: boolean;
    /**
     * `add` is the new-note sheet: flat fields on the container's own surface.
     * `edit` is the detail view's editor: outlined fields, a monospace body.
     */
    variant?: 'add' | 'edit';
    /** Focus the title on mount — what a freshly opened new-note sheet wants. */
    autofocusTitle?: boolean;
  }

  let {
    title = $bindable(),
    content = $bindable(),
    busy,
    variant = 'edit',
    autofocusTitle = false
  }: Props = $props();

  const { t } = useLocale();
  const { after } = useTimer();

  let textAreaRef: HTMLTextAreaElement | null = $state(null);
  let showHeadingDropdown = $state(false);

  // An action rather than an `{#if}` around two copies of the same input: `autofocus` is
  // one call at mount, so branching the markup on it would fork the field itself.
  const focusIf = (node: HTMLElement, enabled: boolean) => {
    if (enabled) node.focus();
  };

  // The two paint jobs, kept as whole class strings rather than a pile of conditional
  // tokens: each is exactly what one of the two call sites in `index.svelte` had.
  const styles = {
    add: {
      root: 'gap-3',
      titleField:
        'bg-surface-container-high placeholder-on-surface-variant w-full rounded-chip p-2 text-lg font-bold',
      contentField:
        'no-scrollbar bg-surface-container-high placeholder-on-surface-variant h-full w-full resize-none rounded-chip p-2 pb-12',
      toolbar:
        'border-outline bg-surface-container shadow-elevation-3 absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-box border p-1',
      toolbarButton: 'text-on-surface hover:bg-surface-container-high rounded-chip p-2',
      placeholder: 'notes.contentPlaceholder'
    },
    edit: {
      root: 'gap-4',
      titleField:
        'border-outline-variant bg-surface-container placeholder-on-surface-variant w-full rounded-chip border p-2 text-xl font-bold focus:border-yellow-500 focus:outline-none',
      contentField:
        'no-scrollbar border-outline-variant bg-surface-container placeholder-on-surface-variant text-body-medium h-full w-full resize-none rounded-chip border p-2 pb-12 font-mono focus:border-yellow-500 focus:outline-none',
      toolbar:
        'border-outline bg-surface-container-high shadow-elevation-3 absolute right-2 bottom-2 left-2 flex justify-evenly gap-1 rounded-box border p-1 backdrop-blur',
      toolbarButton: 'text-on-surface hover:bg-surface-container-highest rounded-chip p-2',
      placeholder: 'notes.markdownPlaceholder'
    }
  } as const;

  const style = $derived(styles[variant]);

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

    content = textBefore + prefix + selectedText + suffix + textAfter;

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
</script>

<div class="flex min-h-0 flex-1 flex-col {style.root}">
  <input
    class={style.titleField}
    placeholder={$t('notes.titlePlaceholder')}
    bind:value={title}
    use:focusIf={autofocusTitle}
    disabled={busy}
  />

  <div class="relative min-h-0 flex-1">
    <textarea
      class={style.contentField}
      placeholder={$t(style.placeholder)}
      bind:this={textAreaRef}
      bind:value={content}
      disabled={busy}></textarea>

    <!-- Markdown Toolbar -->
    <div class={style.toolbar}>
      <button
        class="{style.toolbarButton} font-bold"
        onclick={() => insertMarkdown('**', '**', 'bold')}
        title={$t('notes.bold')}>B</button
      >
      <button
        class="{style.toolbarButton} font-serif italic"
        onclick={() => insertMarkdown('*', '*', 'italic')}
        title={$t('notes.italic')}>I</button
      >
      <button
        class={style.toolbarButton}
        onclick={() => insertMarkdown('- ', '', 'item')}
        title={$t('notes.insertList')}
      >
        <ListBulletIcon />
      </button>
      <button
        class={style.toolbarButton}
        onclick={() => insertMarkdown('- [ ] ', '', 'task')}
        title={$t('notes.insertTask')}
      >
        <CheckCircleIcon />
      </button>
      <div class="relative">
        <button
          class="{style.toolbarButton} font-bold"
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
</div>
