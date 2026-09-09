// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One soft-deleted row, as any of Contacts, Notes or Media can describe it.
 *
 * Deliberately this thin. `status = 'deleted'` exists so a reported row survives its owner
 * deleting it (`Reports.ts`/`moderation.ts` still needs to reach it) — MICA-75 is only about
 * giving the owner a way back in, and every app that wants one has a name and a timestamp
 * for a row even when the row's own shape is otherwise nothing alike: a contact's display
 * name, a note's title, a photo's caption or its `kind`. `preview` is the one field that is
 * genuinely optional — a note has an excerpt worth a second line, a contact usually does not.
 *
 * Declared here rather than inside `RecentlyDeleted.svelte`, where it started (MICA-189):
 * the name is on the public barrel, and a type declared in a `.svelte` script is visible
 * only to a compiler that understands Svelte. `svelte-check` resolved it, but plain `tsc`
 * sees `declare module '*.svelte'` with no such member, so the docs build failed with TS2614
 * and — once that error was skipped — rendered the published name as `any`. A `.ts` sibling
 * is the one shape all three compilers agree on; the component imports it from here.
 */
export interface RecentlyDeletedItem {
  id: string | number;
  label: string;
  /** A second line under the label — a note's excerpt, a contact's number. Omit if there's nothing worth showing. */
  preview?: string;
  deletedAt: string | number | Date;
}
