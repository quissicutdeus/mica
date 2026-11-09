# A thread open's cost is not the scroll write

MICA-448, 2026-11-08, Chromium 103 at 4x CPU. Opening a Messages thread is one
task: the click handler's microtasks render the bubbles, and the layout runs in
the same task whether `scrollTop = scrollHeight` forces it or not. Deferring the
write to `requestAnimationFrame` measured identical (470 vs 445 ms);
`column-reverse` can only save that same write, and it inverts `usePagedList`'s
`scrollTop <= threshold` paging.

Where the time actually went:

- **~110 ms of the cold layout is one-time per session**, not per row. A warm
  second open laid out 433 dirty objects in 14 ms against 124 ms cold. Every
  bubble renders `ReactionBar` → `EmojiPicker`'s six visible emoji, and the
  first emoji shaping pays colour-emoji font fallback (Linux Noto here; Windows
  CEF unmeasured).
- **`formatTime` is ~2/3 of a bubble's script**: `toLocaleTimeString` with
  options builds a fresh Intl formatter per call. It lives in
  `sdk/lib/formatters.ts`, so the fix is `sdk`'s.
- Tearing down the conversation list costs as much again as the formatter calls.

**Why:** a ticket's "forced layout of N nodes" figure can be a first-use font
cost. Run a warm open (open, Back, open again) before blaming node count.

**How to apply:** check `Layout`'s `beginData.dirtyObjects` against its
duration, cold and warm. A CDP probe for this lives only in a scratchpad.
Rebuild it from Playwright, `Tracing` (`devtools.timeline`), and top-level
`RunTask` deduped by overlap, since nested `RunTask`s double-count.

A CPU profile overstated the conversation-list teardown (~66 ms of samples).
Keeping the list mounted and hidden saved nothing measurable on the open; it
saved ~20 ms on Back (70 → 48 ms). Measure with the trace before acting on a
profile share.
