import { get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';

// The wording itself lives in `sdk/privacyNotice.ts`, state-free, so `sdk/addon.ts` can
// re-export it into a sandboxed add-on bundle unchanged. Re-exported here too, so anything
// already importing this file for the "seen" flag can reach the text from the one place
// it actually lives without a second import line.
export { PRIVACY_NOTICE_TEXT } from '../../../../sdk/privacyNotice';

/**
 * Shown once, to every character — new and existing alike.
 *
 * Deliberately **not** migrated the way `onboarding.ts`'s app-drawer hint is for a save
 * from before it shipped. That hint is a UX affordance a veteran has already learned by
 * using the drawer, so treating an old save as "already seen" costs them nothing. This is
 * a disclosure nobody has actually been told yet — an existing character has been sending
 * messages this whole time with no idea they are readable by an admin — so silently marking
 * every old save "seen" would be the exact failure this ticket exists to fix. A returning
 * player sees it once, the same as a new one.
 */
export const privacyNoticeSeen = usePersisted<boolean>('settings', 'privacyNoticeSeen', false);

export function markPrivacyNoticeSeen(): void {
  if (!get(privacyNoticeSeen)) privacyNoticeSeen.set(true);
}
