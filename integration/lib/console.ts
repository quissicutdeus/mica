// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sleep, type Signal } from './wait';

/**
 * What micaOS says on the console, read back (MICA-302).
 *
 * Its console commands answer only there — `micaschema` prints a report, `micacrypt` counts,
 * `micaimport` a table per line — so a scenario that drives one through `ExecuteCommand` reads
 * its answer the way an operator would. `RegisterConsoleListener` hands every console print to
 * this resource; each is kept as plain text, colour codes stripped, a line at a time.
 */
export interface ConsoleLine {
  seq: number;
  channel: string;
  text: string;
}

/**
 * FXServer's `^0`-`^9` colour codes and ANSI escapes, which sit between the words. Built from
 * the escape's code rather than written into the literal, which would be a control character
 * in a regex.
 */
const ESC = String.fromCharCode(27);
const COLOUR = new RegExp(`\\^\\d|${ESC}\\[[0-9;]*m`, 'g');

/** One print as the lines it holds, cleaned. Empty lines are dropped. */
export const consoleLines = (message: unknown): string[] =>
  String(message ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(COLOUR, '').trimEnd())
    .filter((line) => line.trim() !== '');

/** The most lines kept: far more than a run prints, and a bound on a chatty server. */
const KEEP = 20_000;

export class ConsoleTap {
  private readonly lines: ConsoleLine[] = [];
  private next = 0;

  /** `ignore` is this resource's own channel: its protocol lines are not micaOS speaking. */
  constructor(private readonly ignore: string) {}

  push(channel: unknown, message: unknown): void {
    const from = String(channel ?? '');
    if (from === this.ignore) return;
    for (const text of consoleLines(message)) {
      this.lines.push({ seq: this.next++, channel: from, text });
    }
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
  }

  /** A position to read from: every line pushed after this call has a `seq` at or above it. */
  mark(): number {
    return this.next;
  }

  since(mark: number): string[] {
    return this.lines.filter((line) => line.seq >= mark).map((line) => line.text);
  }

  /**
   * The first line at or after `mark` that matches, waiting for it up to `timeoutMs`. Throws
   * with what *was* said since the mark, which is the diagnosis when the expected line never
   * comes.
   */
  async waitFor(
    mark: number,
    match: RegExp,
    timeoutMs: number,
    signal: Signal,
    what: string
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find((line) => line.seq >= mark && match.test(line.text));
      if (found) return found.text;
      if (signal.aborted) throw new Error(`gave up waiting for ${what}`);
      if (Date.now() >= deadline) {
        const said = this.since(mark)
          .filter((line) => /^\s*\[(mica|micaOS|micacrypt|micaimport|micamedia)\]/.test(line))
          .slice(-4)
          .join(' | ');
        throw new Error(
          `no ${what} within ${timeoutMs} ms` + (said ? `; micaOS said: ${said}` : '; nothing said')
        );
      }
      await sleep(100);
    }
  }
}

let tap: ConsoleTap | null = null;

/** The one tap, registered on first use. Null when this FXServer has no console listener. */
export const consoleTap = (): ConsoleTap | null => {
  if (tap) return tap;
  if (typeof RegisterConsoleListener !== 'function') return null;
  const created = new ConsoleTap(`script:${GetCurrentResourceName()}`);
  RegisterConsoleListener((channel: string, message: string) => created.push(channel, message));
  tap = created;
  return tap;
};

/** The tap, or a throw a scenario reports as its reason. */
export const requireTap = (): ConsoleTap => {
  const found = consoleTap();
  if (!found) throw new Error('this FXServer has no RegisterConsoleListener to read micaOS with');
  return found;
};
