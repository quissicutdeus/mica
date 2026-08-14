import { SchemaMigrator } from '../lib/SchemaMigrator';
import { runPendingMigrations, reportPendingMigrations } from '../lib/migrations';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';

/**
 * Schema reconciliation at resource start, plus a dry run and an explicit apply on demand.
 *
 * Triggered by `onResourceStart`, not import order, so every `defineService` call has
 * registered before the declarations are read.
 */

/**
 * `gphoneschema apply` — actually change the database. Console-only: `source === 0` is the
 * same trust tier `docs/security.md` already draws around the console, and the one that can
 * actually take a backup first, which an in-game admin typically cannot (see docs/roadmap.md,
 * "Versioned migrations for breaking schema changes"). Runs both halves in one pass: the
 * additive statements `SchemaMigrator.plan()` already generates, then any pending versioned
 * migrations, in order.
 */
export const runApply = async (source: number): Promise<void> => {
  if (source !== 0) {
    console.log('[gphoneschema] apply only runs from the server console.');
    return;
  }

  const additive = await SchemaMigrator.apply();
  for (const line of additive) console.log(`[gphone] ${line}`);

  const result = await runPendingMigrations();
  for (const id of result.applied) console.log(`[gphone] applied migration ${id}`);
  if (result.failed) {
    console.error(`[gphone] migration ${result.failed.id} failed: ${result.failed.error}`);
    if (result.remaining.length > 0) {
      console.error(`[gphone] not attempted: ${result.remaining.join(', ')}`);
    }
    return;
  }

  if (additive.length === 0 && result.applied.length === 0) {
    console.log('[gphone] schema is already up to date.');
  }
};

/**
 * `gphoneschema` — print what would change, without changing it.
 *
 * Worth having even with `apply` available: it is how you check a live server before an
 * update, and how you see the drift the migrator deliberately refuses to touch.
 */
RegisterCommand(
  'gphoneschema',
  (source: number, args: string[]) => {
    const sub = (args?.[0] ?? '').toLowerCase();

    if (sub === 'apply') {
      void runApply(source).catch((error) => {
        console.error('[gphoneschema] apply failed:', error);
      });
      return;
    }

    if (!isAdmin(source)) {
      notifyPlayer(source, {
        type: 'error',
        message: 'You do not have permission to use that.'
      });
      return;
    }
    void SchemaMigrator.report();
  },
  false
);

/**
 * Report on resource start. Reports only — nothing here changes the database.
 *
 * There was an auto-apply behind a `gphone_auto_migrate` convar, adding missing columns
 * and indexes at start. It is gone: `gphone.sql` is generated whole from the declarations
 * and importing it *is* the schema, so a database that disagrees with the code has not
 * drifted, it has not been imported. Saying so is more useful than silently patching
 * halfway there and leaving an operator unsure which half they have. Applying now needs a
 * deliberate `gphoneschema apply` from the console — see `runApply` above — never this hook.
 *
 * `onResourceStart` rather than a deferred timer for two reasons. It fires after the
 * whole controller graph has imported, so `declaredServices` is complete — reading it at
 * module scope would see only the apps imported before this file. And it is inert
 * outside a running server: `pnpm generate:sql` imports every controller to read the
 * declarations, and a timer fired there, reaching for a database that does not exist.
 * A stubbed `on()` simply never calls back.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;
  void SchemaMigrator.report();
  void reportPendingMigrations();
});
