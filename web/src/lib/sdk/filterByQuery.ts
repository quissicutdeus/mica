/**
 * Filter a list by a free-text query against a few of each item's fields.
 *
 * Five apps had written this by hand and no two agreed. Notes lower-cased the query once
 * per field per item; Contacts matched the phone number case-sensitively against a
 * trimmed query while matching the name case-insensitively against an untrimmed one;
 * Messages did it three more times, once per list it shows. None of the differences were
 * decisions — a phone number has no case, and a query with a trailing space should not
 * behave differently depending on which field it lands in.
 *
 * The contract here: an empty or whitespace-only query returns the list unchanged, and a
 * non-empty one keeps an item when any of its fields contains the trimmed query, ignoring
 * case. `fields` returns the strings to search rather than naming keys, so a caller can
 * search a value it composes — Contacts matches against `"firstname lastname"` so that
 * "john sm" finds John Smith, which no per-key match would do.
 *
 * ```ts
 * filterByQuery($notes, searchQuery, (n) => [n.title, n.content]);
 * ```
 */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => (string | null | undefined)[]
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items as T[];

  return items.filter((item) =>
    fields(item).some((field) => (field || '').toLowerCase().includes(needle))
  );
}
