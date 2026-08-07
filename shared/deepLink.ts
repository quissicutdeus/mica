/**
 * Where a notification points, written once and read once.
 *
 * The server builds these and the phone follows them, which is the same reason
 * `shared/richText.ts` lives here: two definitions of the format is how you get a link
 * that is written correctly and never opens. That is not hypothetical — this file exists
 * because there were **three** shapes in the tree and no parser at all.
 *
 *   `mail/12`                     what the server wrote
 *   `gphone://messages?threadId=1` what the browser mocks wrote
 *   `blab/(\d+)` by regex          what Blabber's notifications tab read
 *
 * And nothing parsed any of them: `NotificationShade` passed the whole string to
 * `openApp`, which lowercased it and registered a resident app called `"mail/12"`. No
 * component resolves that id, so the screen went blank with the `<Home>` branch skipped
 * too — tapping a Mail notification did that every time.
 *
 * ## The format
 *
 * `app?key=value&key=value`, with an optional `gphone://` prefix that is stripped.
 *
 * A query string rather than a path, because the props are **named**. `useDeepLink`
 * consumers read `mailId`, `conversationId`, `initialPhotoId` — a positional path like
 * `mail/12` would need the parser to know every app's schema, and adding an app would
 * mean editing a central table. A query is self-describing, so an add-on the shell has
 * never heard of can be linked to without anything here changing.
 */

export interface DeepLink {
  /** Registry id of the app to open. */
  app: string;
  /** Props handed to the app, for `useDeepLink` to consume. */
  props: Record<string, string | number>;
}

/** Matches an app id, which is the same shape `defineApp` accepts. */
const APP_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Build a link. The props are the ones the target app's `useDeepLink` reads.
 *
 * Pass the same object as the push payload where you can — a toast navigates from the
 * payload and the notification row from the link, and when they disagree one of the two
 * routes silently goes nowhere.
 */
export function buildDeepLink(app: string, props: Record<string, string | number> = {}): string {
  const query = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  return query ? `${app}?${query}` : app;
}

/**
 * Read a link, or `null` if it is not one.
 *
 * `null` rather than a partial result: the caller's only sane response to a link it
 * cannot understand is to do nothing, and a `{ app: 'mail/12' }` is what blanked the
 * screen in the first place.
 *
 * Digit-only values become numbers. That is not a convenience — `useDeepLink` compares
 * with `===`, so `mailId: '12'` never matches a row whose `id` is `12`, and the link
 * would parse perfectly and still open nothing.
 */
export function parseDeepLink(link: string): DeepLink | null {
  if (typeof link !== 'string') return null;

  const withoutScheme = link.trim().replace(/^gphone:\/\//i, '');
  if (!withoutScheme) return null;

  const [rawApp, rawQuery = ''] = withoutScheme.split('?');
  const app = rawApp.trim().toLowerCase();
  if (!APP_ID.test(app)) return null;

  const props: Record<string, string | number> = {};
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const [rawKey, ...rest] = pair.split('=');
    const key = safeDecode(rawKey);
    if (!key) continue;
    const value = safeDecode(rest.join('='));
    props[key] = /^\d+$/.test(value) ? Number(value) : value;
  }

  return { app, props };
}

/** A malformed escape throws, and a bad link is not worth an exception. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
