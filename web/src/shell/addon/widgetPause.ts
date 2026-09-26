// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, type Readable } from 'svelte/store';

/**
 * MICA-245: the crash-loop breaker for add-on widgets.
 *
 * An add-on's widget runs whenever the home screen shows, and a sandboxed `srcdoc` frame
 * in CEF very likely shares the shell's renderer thread. A widget that never returns —
 * `while (true) {}` in its component — therefore freezes home on every boot, and home is
 * the only way to the Store that could remove it. The shell cannot interrupt a frozen
 * thread, but it can remember that it went in and never came out.
 *
 * So: before a widget frame boots, its app id is written here; once the frame reports its
 * widget mounted (`ready`), or the frame is torn down in an orderly way, it is cleared. A
 * frozen thread does neither. An id still marked at the next load is a widget that hung
 * the phone last time, and it stays paused — `AddOnWidgetFrame` boots nothing for it and
 * the home grid draws "Widget paused" — until the player removes and re-adds it, which
 * calls `resumeWidget`.
 *
 * Plain `localStorage` under a key outside every `mica:<appId>:` namespace, deliberately:
 * an add-on's hydrate snapshot is its own `mica:<appId>:` keys, so a marker there would be
 * readable, and clearable, by the very add-on it is about. Not per character either — a
 * frozen home screen is a property of the machine, not of whoever was holding the phone.
 */
const KEY = 'mica_widget_booting';

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    );
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage refused (quota, a private profile): the breaker cannot remember, so it fails
    // open — the widget boots as it would have before this existed.
  }
}

const paused = writable<ReadonlySet<string>>(read());

/**
 * App ids whose widget hung the phone on a previous load, and will not boot until the
 * player removes and re-adds it. Read-only: `resumeWidget` is the one way out.
 */
export const pausedWidgets: Readable<ReadonlySet<string>> = { subscribe: paused.subscribe };

/** Called just before a widget frame boots. */
export function markWidgetBooting(appId: string): void {
  const ids = read();
  ids.add(appId);
  write(ids);
}

/** The widget mounted, or its frame was torn down on purpose — it did not hang. */
export function markWidgetSettled(appId: string): void {
  const ids = read();
  if (ids.delete(appId)) write(ids);
}

/** The player re-added a paused widget: forget the hang and let it boot again. */
export function resumeWidget(appId: string): void {
  markWidgetSettled(appId);
  paused.update((s) => {
    if (!s.has(appId)) return s;
    const next = new Set(s);
    next.delete(appId);
    return next;
  });
}

/** Re-reads storage as a fresh page load would. Tests only. */
export function __reloadPausedWidgetsForTest(): void {
  paused.set(read());
}
