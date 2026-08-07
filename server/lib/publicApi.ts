/**
 * Every export gPhone publishes, in one place.
 *
 * The scaffolding is `lib/exports.ts`; this is the surface itself. Split because the rules
 * about outcomes and never throwing are worth reading without the catalogue in the way,
 * and the catalogue is worth reading without the rules in the way.
 *
 * Registration happens from `server.ts` **after** `./services`, so every service has
 * finished loading before any of this can be called. Registering from inside each service
 * would put the surface back where it was — spread across the files that implement it,
 * where nothing can check it.
 */
import { FrameworkBridge } from './FrameworkBridge';
import { appEventChannel } from './appEvents';
import { buildDeepLink, parseDeepLink } from '@shared/deepLink';
import { knownServices } from './services';
import {
  MICA_API_VERSION,
  ExportOutcome,
  fail,
  guarded,
  guardedAsync,
  ok,
  publish
} from './exports';
import { SendSystemEmail } from '../services/Mail';
import { getBatteryLevel, setBatteryLevel, setCharging } from '../services/Battery';

/**
 * How an external resource names itself in the notification shade.
 *
 * `ext_<resource>` rather than a free string, and the reservation is enforced at the other
 * end: `defineApp` rejects an id starting with `ext_`, so an external id can never collide
 * with a gPhone app that ships later. Without that check the prefix is a convention, and a
 * convention is what fails the day somebody ships an app called `ext_tracker`.
 */
const EXTERNAL_PREFIX = 'ext_';

const APP_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Which `app` values an external caller may group a notification under.
 *
 * Validated against `knownServices()`, which is every service the server answers to. That
 * is an approximation of "every app": an app with no server service — Calculator — cannot
 * be named here. It is the right approximation anyway, because an app with no service has
 * nothing to show when the player taps the notification.
 */
const isKnownApp = (app: string): boolean => knownServices().includes(app);

export interface ExternalNotification {
  /** A gPhone app id, or `ext_<resource>` for your own group. */
  app: string;
  /** Required for an `ext_` id, refused for a real app id. What the shade shows as the group. */
  sourceLabel?: string;
  title: string;
  body: string;
  /** An image URL, shown in place of the group's initial. */
  avatar?: string;
  /** Where tapping should land, as `app?key=value`. Built with `buildDeepLink`. */
  deepLink?: string;
  kind?: string;
}

/**
 * Raise a notification on a player's phone.
 *
 * Keyed by **citizenid**, not source, so it works while the player is offline: the row is
 * written either way and they see it when they next open the phone. The return value says
 * which happened.
 */
const SendNotification = (
  citizenid: unknown,
  options: unknown
): ExportOutcome<{ delivered: boolean }> => {
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail('invalid_args', 'A citizenid is required.');
  }
  if (!options || typeof options !== 'object') {
    return fail('invalid_args', 'A notification object is required.');
  }

  const opts = options as Partial<ExternalNotification>;
  const app = String(opts.app ?? '').toLowerCase();

  if (!APP_ID.test(app)) {
    return fail('invalid_args', `'${opts.app}' is not a valid app id.`);
  }

  const isExternal = app.startsWith(EXTERNAL_PREFIX);

  // Nothing validated `app` before this existed, at any layer — the field was mandatory
  // and its value was whatever arrived. An external caller makes that worth closing.
  if (!isExternal && !isKnownApp(app)) {
    return fail(
      'invalid_args',
      `'${app}' is not a gPhone app. Use 'ext_<resource>' for your own notifications.`
    );
  }
  if (isExternal && !String(opts.sourceLabel ?? '').trim()) {
    return fail('invalid_args', `An '${EXTERNAL_PREFIX}' app id requires a sourceLabel.`);
  }
  if (!isExternal && opts.sourceLabel) {
    return fail('invalid_args', 'sourceLabel applies only to an ext_ app id.');
  }

  const title = String(opts.title ?? '').trim();
  const body = String(opts.body ?? '').trim();
  if (!title) return fail('invalid_args', 'A title is required.');

  // Refused rather than dropped. A link that does not parse means the caller believes
  // tapping goes somewhere, and silently landing on the app's home screen is the failure
  // this codebase has already paid for once.
  if (opts.deepLink && !parseDeepLink(String(opts.deepLink))) {
    return fail('invalid_args', `'${opts.deepLink}' is not a valid deep link.`);
  }

  const outcome = appEventChannel(app).push(
    citizenid,
    'external',
    { source_label: opts.sourceLabel ?? null },
    {
      notify: { type: 'info', title, message: body },
      kind: String(opts.kind ?? 'external'),
      title,
      deepLink: opts.deepLink ? String(opts.deepLink) : undefined
    }
  );

  // `offline` is a success here and not a failure: the row is written, and the player sees
  // it when they next open the phone. Only the toast did not happen.
  return ok({ delivered: outcome.delivered });
};

/** Resolve a source to a loaded character, or say which way it failed. */
const citizenOf = (source: unknown): { citizenid: string } | ExportOutcome<never> => {
  if (typeof source !== 'number' || !Number.isInteger(source) || source <= 0) {
    return fail<never>('invalid_args', 'A player source is required.');
  }
  const player = FrameworkBridge.getPlayer(source);
  if (!player?.citizenid) {
    return fail<never>('unknown_player', 'No character is loaded on that player.');
  }
  return { citizenid: player.citizenid };
};

const isFailure = <T>(value: unknown): value is ExportOutcome<T> =>
  typeof value === 'object' && value !== null && 'ok' in value;

export function registerPublicApi(): void {
  publish(
    'GetApiVersion',
    guarded('GetApiVersion', () => ok(MICA_API_VERSION))
  );

  /**
   * The one export that already existed, moved here.
   *
   * Its signature is unchanged and it still returns the mail row or null, because server
   * owners are calling it today and a version bump is not worth breaking them for tidiness.
   * New exports use the outcome shape.
   */
  publish('SendSystemEmail', SendSystemEmail);

  publish('SendNotification', guarded('SendNotification', SendNotification));

  /** Build a deep link without needing to know the format. */
  publish(
    'BuildDeepLink',
    guarded('BuildDeepLink', (app: unknown, props: unknown) => {
      const id = String(app ?? '').toLowerCase();
      if (!APP_ID.test(id)) return fail<string>('invalid_args', `'${app}' is not a valid app id.`);
      return ok(buildDeepLink(id, (props ?? {}) as Record<string, string | number>));
    })
  );

  publish(
    'GetBatteryLevel',
    guardedAsync('GetBatteryLevel', async (source: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      return ok(await getBatteryLevel(resolved.citizenid));
    })
  );

  publish(
    'SetBatteryLevel',
    guardedAsync('SetBatteryLevel', async (source: unknown, level: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      if (typeof level !== 'number' || !Number.isFinite(level)) {
        return fail<number>('invalid_args', 'A level between 0 and 100 is required.');
      }
      return ok(await setBatteryLevel(source as number, level));
    })
  );

  /** Negative drains — an EMP, a taser, a long night. */
  publish(
    'AddBatteryCharge',
    guardedAsync('AddBatteryCharge', async (source: unknown, delta: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return fail<number>('invalid_args', 'A numeric delta is required.');
      }
      const current = await getBatteryLevel(resolved.citizenid);
      return ok(await setBatteryLevel(source as number, current + delta));
    })
  );

  /**
   * Charging is a **state**, not an event.
   *
   * The drain loop is client-side and moves the charge 0.25% every 15 seconds, so
   * "charging" has to live where the drain rate lives. Repeatedly poking
   * `AddBatteryCharge` from a house script would fight that loop rather than join it.
   */
  publish(
    'SetCharging',
    guarded('SetCharging', (source: unknown, isCharging: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<never>;
      setCharging(source as number, isCharging === true);
      return ok();
    })
  );
}
