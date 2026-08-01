import { SchemaMigrator } from '../lib/SchemaMigrator';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';

/**
 * Schema reconciliation at resource start, plus a dry run on demand.
 *
 * Triggered by `onResourceStart`, not import order, so every `defineService` call has
 * registered before the declarations are read.
 */

/**
 * `gphoneschema` — print what would change, without changing it.
 *
 * Worth having even with auto-migrate on: it is how you check a live server before an
 * update, and how you see the drift the migrator deliberately refuses to touch.
 */
RegisterCommand(
  'gphoneschema',
  (source: number) => {
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
 * Reconcile on resource start.
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
  void SchemaMigrator.run();
});
