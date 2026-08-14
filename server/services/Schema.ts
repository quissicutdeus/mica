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
 * `gphoneschema apply` — actually change the database.
 *
 * Console-only: `source === 0` is the trust tier AGENTS.md §1 already draws around the
 * server console, and it is the one that can take a backup first, which an in-game admin
 * typically cannot. One command rather than two, because an operator thinks "bring my
 * database up to date", not "apply the two kinds of change separately". See AGENTS.md §8,
 * "Schema changes", for the whole design.
 *
 * **Versioned migrations first, then the additive pass**, and the order is the load-bearing
 * part. The additive planner reads the declaration, which already describes the *post*-
 * migration shape: given a migration renaming `image` to `data`, the planner sees `data`
 * declared, finds no such column live, and adds an empty one — after which the rename fails
 * on a duplicate column, and the real data is stranded in a column nothing reads. Running
 * the migration first leaves the additive pass looking at a table that has already caught
 * up, where its whole job is the columns no migration was ever written for.
 *
 * A failed migration stops the whole command. A half-migrated table is exactly the state
 * the additive planner cannot reason about, so patching it further is the one thing not to
 * do next.
 */
export const runApply = async (source: number): Promise<void> => {
  if (source !== 0) {
    console.log('[gphoneschema] apply only runs from the server console.');
    return;
  }

  const result = await runPendingMigrations();
  for (const id of result.applied) console.log(`[gphone] applied migration ${id}`);
  if (result.failed) {
    console.error(`[gphone] migration ${result.failed.id} failed: ${result.failed.error}`);
    if (result.remaining.length > 0) {
      console.error(`[gphone] not attempted: ${result.remaining.join(', ')}`);
    }
    console.error('[gphone] additive changes were not applied — fix the migration first.');
    return;
  }

  const additive = await SchemaMigrator.apply();
  for (const line of additive.applied) console.log(`[gphone] ${line}`);
  if (additive.failed) {
    console.error(`[gphone] ${additive.failed.description} failed: ${additive.failed.error}`);
    if (additive.remaining.length > 0) {
      console.error(`[gphone] not attempted: ${additive.remaining.join(', ')}`);
    }
    return;
  }

  if (additive.applied.length === 0 && result.applied.length === 0) {
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
    // Before the sub-dispatch, so a player without the ace gets the same refusal whichever
    // form they typed. `apply` would still refuse them on `source !== 0`, but silently and
    // only in the server console — nothing in front of the player, and a log line they can
    // repeat at will.
    if (!isAdmin(source)) {
      notifyPlayer(source, {
        type: 'error',
        message: 'You do not have permission to use that.'
      });
      return;
    }

    // `isAdmin(0)` is true — the console is trusted by definition (AGENTS.md §1) — so this
    // gate does not stand between an operator and `apply`.
    if ((args?.[0] ?? '').toLowerCase() === 'apply') {
      void runApply(source).catch((error) => {
        console.error('[gphoneschema] apply failed:', error);
      });
      return;
    }

    void SchemaMigrator.report();
  },
  false
);

/**
 * Report on resource start. Reports only — nothing here changes the database, including the
 * migrations ledger, which only `gphoneschema apply` ever creates.
 *
 * There was an auto-apply behind a `gphone_auto_migrate` convar, adding missing columns
 * and indexes at start. It is gone: a boot that changes the schema by itself gives an
 * operator no moment at which to take a backup, and no say in whether today is the day.
 * Applying is a deliberate `gphoneschema apply` from the console — see `runApply` above —
 * never this hook.
 *
 * Both reports are `.catch()`ed rather than left as bare `void` promises. This runs before
 * anything is guaranteed to be up: oxmysql may not have started, the database user may lack
 * a privilege, and an unhandled rejection at boot is a stack trace in the operator's console
 * on a resource that is otherwise fine.
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
  void reportPendingMigrations().catch((error) => {
    console.error('[gphone] could not report pending schema migrations:', error);
  });
});
