import { tick } from 'svelte';

export interface PagedListOptions<T> {
  /** The full list. Read reactively, so it may grow underneath the window. */
  items: () => T[];
  /** How many more rows each page reveals. */
  pageSize?: number;
  /**
   * Which end of the list the *older* rows are at.
   *
   * `'start'` is a chat: the window holds the newest rows, older ones are above, and
   * revealing them has to preserve the reader's place. `'end'` is a feed: the window
   * holds the newest rows too, but older ones are below and revealing them changes
   * nothing the reader is already looking at.
   */
  olderAt?: 'start' | 'end';
  /** The scrolling element, needed only for `olderAt: 'start'`. */
  container?: () => HTMLElement | null;
  /** Distance from the edge, in pixels, at which scrolling asks for more. */
  threshold?: number;
}

/**
 * OS Service Hook for a long list revealed a page at a time.
 *
 * Extracted from Messages, which had the whole thing written out: a page size, a
 * display limit, a derived window, a hidden-count, an index offset so keyed rows kept
 * their identity, a re-entrancy guard, and the scroll-height arithmetic that stops the
 * view from jumping when older messages appear above the fold. That last part is the
 * reason this is worth sharing — it is the piece everyone forgets, and getting it wrong
 * is invisible until a thread is long enough to scroll.
 *
 * `olderAt` is what makes it serve both shapes. A chat grows upward and must compensate;
 * a feed grows downward and must not. Both window the newest rows first.
 *
 * ```ts
 * const page = usePagedList({
 *   items: () => messages,
 *   olderAt: 'start',
 *   container: () => document.getElementById('messages-container')
 * });
 *
 * // {#each page.visible as msg, i (msg.id)}  — index i + page.offset is the real one
 * // <div onscroll={page.onScroll}>
 * ```
 *
 * A rune module: the window is derived from state the caller owns and must re-derive
 * when either the list or the limit changes.
 */
export function usePagedList<T>(options: PagedListOptions<T>) {
  const pageSize = options.pageSize ?? 50;
  const olderAt = options.olderAt ?? 'start';
  const threshold = options.threshold ?? 40;

  let limit = $state(pageSize);
  let loading = $state(false);

  const all = $derived(options.items());
  const windowed = $derived(all.length <= limit);

  const visible = $derived(
    windowed ? all : olderAt === 'start' ? all.slice(all.length - limit) : all.slice(0, limit)
  );

  /**
   * How many rows the window is hiding, and where the visible slice starts.
   *
   * `offset` matters for `{#each ... as item, i}`: without it the index inside the
   * window is not the index in the list, and anything keyed on position silently
   * addresses the wrong row once a page has been revealed.
   */
  const hiddenCount = $derived(all.length - visible.length);
  const offset = $derived(olderAt === 'start' ? all.length - visible.length : 0);

  const loadMore = async (): Promise<void> => {
    if (hiddenCount <= 0 || loading) return;
    loading = true;

    const el = olderAt === 'start' ? (options.container?.() ?? null) : null;
    const previousHeight = el ? el.scrollHeight : 0;
    const previousTop = el ? el.scrollTop : 0;

    limit += pageSize;
    await tick();

    // Keep the reader where they were. The list just grew above them, so the same
    // content now sits further down by exactly the height that was added.
    if (el) el.scrollTop = el.scrollHeight - previousHeight + previousTop;

    loading = false;
  };

  const onScroll = (event: Event): void => {
    const el = event.target as HTMLElement | null;
    if (!el || hiddenCount <= 0) return;

    const atEdge =
      olderAt === 'start'
        ? el.scrollTop <= threshold
        : el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

    if (atEdge) void loadMore();
  };

  /** Back to one page. Call when the list is replaced rather than appended to. */
  const reset = (): void => {
    limit = pageSize;
  };

  return {
    get visible() {
      return visible;
    },
    get hiddenCount() {
      return hiddenCount;
    },
    get offset() {
      return offset;
    },
    get loading() {
      return loading;
    },
    loadMore,
    onScroll,
    reset
  };
}
