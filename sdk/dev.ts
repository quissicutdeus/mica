// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@mica/sdk/dev` — the add-on dev loop's half of the SDK (MICA-311). **Never in a bundle you
 * ship.**
 *
 * `pnpm dev` in the add-on template serves your bundle from loopback and a phone shell built to
 * allow it loads it into the normal sandboxed frame. Your server half is not there — no FiveM
 * server is — so its answers come from a mock **inside your own frame**, written once in
 * `src/mock.ts` with the same handler type `exports.mica:RegisterService` takes:
 *
 * ```ts
 * // src/mock.ts
 * export default defineAddonMock(notes, ({ push }) => ({
 *   list: () => rows,
 *   add: (_citizenid, { text }) => { rows.push(...); push('added', { id }); return row; }
 * }));
 *
 * // the template's dev entry, development mode only
 * installAddonMock(mock, manifest);
 * ```
 *
 * Kept off the `@mica/sdk` barrel on purpose, so a production bundle cannot reach it by
 * accident: the template's build refuses any import of this entry point outside development,
 * and a production bundle is checked for the mock's marker string.
 */
export { installAddonMock } from './host/iframe/devMock';
export { defineAddonMock } from '@mica/shared/addonService';
/** @public */
export type { AddonMockDefinition, AddonMockTools } from '@mica/shared/addonService';
