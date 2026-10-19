// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The add-on barrel's own types for the ten hooks whose facet carries a member only a core
 * app can call.
 *
 * `Facets` is one type for both sides, and every hook in `host/` returns its facet's whole
 * shape. So `useKeybindsWrite().setBinding` type-checked in an add-on and was refused at
 * run time as "core only", and twenty-nine members across seven facets read that way before
 * 2026-10-19 (thirty-four with `lockScreenWrite` emptied and the two inbox landings taken
 * off `mail` and `messages`). Each export here is the very same function as the core hook,
 * re-typed to return what the shell will actually answer: the hook's own return type minus
 * `CoreOnlyMember` of its facet. `addon.ts` names these after `export * from
 * './host/index'`, and a named export wins over a star export of the same name, so
 * `@mica/sdk` hands an add-on these types and a core app keeps the full ones.
 *
 * Type-only narrowing, nothing at run time: the shell's `requireMember` is still the
 * boundary, and a raw `postMessage` naming a hidden member is refused as before.
 *
 * `permissions.test.ts` holds this file total: one export per facet in `FacetWithCoreOnly`,
 * each identical at run time to the core hook. A row emptied in `FACET_MEMBERS` therefore
 * fails there until its hook is narrowed here too.
 */
import type { CoreOnlyMember, FacetWithCoreOnly } from '../../permissions';
import { useAppRegistryWrite as coreAppRegistryWrite } from '../useAppRegistryWrite';
import { useDisplayWrite as coreDisplayWrite } from '../useDisplayWrite';
import { useKeybindsWrite as coreKeybindsWrite } from '../useKeybindsWrite';
import { useLocale as coreLocale } from '../useLocale';
import { useLockScreenWrite as coreLockScreenWrite } from '../useLockScreenWrite';
import { useMail as coreMail } from '../useMail';
import { useMessages as coreMessages } from '../useMessages';
import { useNotificationSettingsWrite as coreNotificationSettingsWrite } from '../useNotificationSettingsWrite';
import { useStreamerMode as coreStreamerMode } from '../useStreamerMode';
import { useSystemHardwareWrite as coreSystemHardwareWrite } from '../useSystemHardwareWrite';

/** `hook`, returning what it returns minus the members of facet `F` only a core app can call. */
type ForAddOn<H extends (...args: never[]) => object, F extends FacetWithCoreOnly> = (
  ...args: Parameters<H>
) => Omit<ReturnType<H>, CoreOnlyMember<F>>;

export const useAppRegistryWrite: ForAddOn<typeof coreAppRegistryWrite, 'appRegistryWrite'> =
  coreAppRegistryWrite;
export const useDisplayWrite: ForAddOn<typeof coreDisplayWrite, 'displayWrite'> = coreDisplayWrite;
export const useKeybindsWrite: ForAddOn<typeof coreKeybindsWrite, 'keybindsWrite'> =
  coreKeybindsWrite;
export const useLocale: ForAddOn<typeof coreLocale, 'locale'> = coreLocale;
export const useLockScreenWrite: ForAddOn<typeof coreLockScreenWrite, 'lockScreenWrite'> =
  coreLockScreenWrite;
export const useMail: ForAddOn<typeof coreMail, 'mail'> = coreMail;
export const useMessages: ForAddOn<typeof coreMessages, 'messages'> = coreMessages;
export const useNotificationSettingsWrite: ForAddOn<
  typeof coreNotificationSettingsWrite,
  'notificationSettingsWrite'
> = coreNotificationSettingsWrite;
export const useStreamerMode: ForAddOn<typeof coreStreamerMode, 'streamerMode'> = coreStreamerMode;
export const useSystemHardwareWrite: ForAddOn<
  typeof coreSystemHardwareWrite,
  'systemHardwareWrite'
> = coreSystemHardwareWrite;
