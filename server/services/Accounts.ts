import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Account } from '@shared/types';
import { fields, optionalString, requirePositiveInt } from '../lib/payload';

/**
 * Social identities, shared by every social app.
 *
 * One table with `app` as a column rather than one per app, because the fields do not differ.
 * Blabber, an Instagram-alike and a TikTok-alike all want exactly a handle, a display name, an
 * avatar and a bio — an account is just "an identity you post under", and none of them
 * disagree about what that means. What differs is the *content* model, which stays per app.
 *
 * The alternative — `gphone_blabber_accounts`, `gphone_instagram_accounts` — buys independence
 * nobody asked for and costs the same three things per app: list my accounts, verify this
 * account is mine before accepting a write, and keep handles unique. That is precisely the
 * duplication `isSystemApp` and `isParticipant` were.
 *
 * An app-specific *presentation* field, if one ever genuinely exists, goes in its own table
 * keyed on `account_id`. Adding one needs no change here, which is why starting shared costs
 * nothing later.
 *
 * **A player may hold several accounts per app** and switch between them, so nothing here is
 * one-per-citizenid. That is also why `citizenid` must never reach a public reader: it
 * correlates two deliberately-separate identities back to one person, which is the whole thing
 * an alt exists to prevent. It is excluded from every public projection automatically —
 * see `publicColumns`.
 */
export const accounts = defineService<Account>({
  id: 'accounts',
  access: { read: 'public', write: 'owner' },
  // Required for a public read, and the ceiling a handle search answers within.
  paging: { pageSize: 30, maxPageSize: 60 },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Set by the custom create from the app that asked, never by a generic write — otherwise
     * a player could move an existing account into another app's handle namespace.
     */
    app: {
      type: 'string',
      length: 32,
      notNull: true,
      clientWritable: false,
      clientFilterable: true
    },
    /**
     * Claimed once and not renamed. `clientWritable: false` keeps it out of the generic
     * update, so the editable fields below are safe to expose there: renaming a handle would
     * silently break every mention of it, and there is nothing to un-break it with.
     */
    handle: {
      type: 'string',
      length: 32,
      notNull: true,
      clientWritable: false,
      clientFilterable: true
    },
    display_name: { type: 'string', length: 50 },
    avatar: { type: 'string', length: 255 },
    bio: { type: 'string', length: 160 }
  },
  indexes: [
    /**
     * Unique per app, not globally: `@ada` on Blabber and `@ada` on Instagram are different
     * identities and may well be different people. A real database constraint rather than a
     * find-then-insert, which has a race two players claiming at once would find.
     */
    { name: 'app_handle', columns: ['app', 'handle'], unique: true },
    // The switcher's read: my accounts in this app.
    { name: 'citizenid_app', columns: ['citizenid', 'app'] }
  ],
  // Custom: validates the handle, caps how many a player may hold, and translates a
  // duplicate-key collision into something a player can read.
  options: { disableCreate: true }
});

const app = accounts.app;
const repo = accounts.repo;

/** 3–32 characters, lowercase, alphanumeric and underscore. No leading `@`; that is display. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,32}$/;

const MAX_PER_APP_CONVAR = 'gphone_max_accounts_per_app';
const DEFAULT_MAX_PER_APP = 3;

/**
 * How many identities one player may hold in one app.
 *
 * Capped because the handle namespace is public and finite: without a limit, one player can
 * claim every good name in an afternoon. Three is enough for a main and a couple of alts.
 */
const maxPerApp = (): number => {
  const raw = Number.parseInt(GetConvar(MAX_PER_APP_CONVAR, String(DEFAULT_MAX_PER_APP)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_APP;
};

/**
 * The accounts this player holds in an app.
 *
 * Scoped to the caller server-side and deliberately **not** a filter on the public `get`:
 * making `citizenid` client-filterable would let anyone list anyone's accounts, which is the
 * de-anonymisation this table is built to avoid.
 */
app.registerEvent('mine', async (source, cbId, data, citizenid) => {
  const appId = optionalString(fields(data).app);
  if (!appId) throw new Error('An app id is required.');

  return await Database.query<Account[]>(
    `SELECT * FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     ORDER BY \`id\` ASC`,
    [citizenid, appId]
  );
});

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  const handle = optionalString(body.handle)?.toLowerCase();
  const displayName = optionalString(body.display_name) ?? null;

  if (!appId) throw new Error('An app id is required.');
  if (!handle || !HANDLE_PATTERN.test(handle)) {
    throw new Error('A handle is 3–32 characters, using lowercase letters, numbers and _.');
  }

  const held = await Database.scalar<number>(
    `SELECT COUNT(*) FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'`,
    [citizenid, appId]
  );
  const limit = maxPerApp();
  if ((held ?? 0) >= limit) {
    throw new Error(`You already hold ${limit} accounts here. Delete one to make room.`);
  }

  /**
   * Checked before inserting for the sake of the message, and the unique index is what
   * actually enforces it. Two players claiming the same handle in the same instant both pass
   * this check and one of them loses at the index — which is the correct outcome, and the
   * reason the constraint exists rather than this check standing alone.
   */
  const taken = await Database.single<{ id: number }>(
    'SELECT `id` FROM `gphone_accounts` WHERE `app` = ? AND `handle` = ? LIMIT 1',
    [appId, handle]
  );
  if (taken) throw new Error(`@${handle} is taken.`);

  try {
    const id = await repo.create({ citizenid, app: appId, handle, display_name: displayName });
    return { id, citizenid, app: appId, handle, display_name: displayName, status: 'active' };
  } catch (error) {
    // The index did its job in a race. Translate it, because the raw driver error reaches a
    // player's toast and reads as a crash.
    const message = error instanceof Error ? error.message : '';
    if (/duplicate/i.test(message)) throw new Error(`@${handle} is taken.`);
    throw error;
  }
});

/**
 * Is this account one the caller may post as?
 *
 * Exported for the social apps: a post carries an `account_id` the client chose, and nothing
 * about that payload proves the account belongs to the session that sent it (§2.9). Every app
 * accepting an `account_id` calls this first.
 *
 * Returns the account rather than a boolean, because the caller almost always needs the handle
 * next and a second read would be wasted.
 */
export async function ownedAccount(
  accountId: unknown,
  citizenid: string,
  appId: string
): Promise<Account | null> {
  let id: number;
  try {
    id = requirePositiveInt(accountId, 'account id');
  } catch {
    return null;
  }

  return await Database.single<Account>(
    `SELECT * FROM \`gphone_accounts\`
     WHERE \`id\` = ? AND \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     LIMIT 1`,
    [id, citizenid, appId]
  );
}
