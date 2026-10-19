// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { call, invoke, seedPlayer } from '../lib/door';
import { assert, seedCitizen } from '../lib/mica';
import { schemaCreated } from './qbx';

/**
 * A report's takedown and its reopen (MICA-386, `server/services/Reports.ts`) inside a real
 * FXServer on a real MariaDB, driven through the integration door (MICA-397, `../lib/door.ts`).
 *
 * MICA-386 was a reopen putting the reported row back to `active` whatever it had been: a post
 * its author deleted came back live. A takedown now records the status it replaced on the report
 * (`mica_reports.target_prior_status`) and a reopen writes that back. Both paths are held here
 * on a Glimpse post, the reportable row whose create and delete the door already drives: one the
 * author deleted after it was reported stays deleted through moderate and reopen, and one still
 * up comes back up.
 *
 * `reports:resolve` and `reports:reopen` are admin actions. The moderator is a door player
 * seeded with `{ admin: true }`, which `isAdmin` answers from the door's flag for a synthetic
 * source alone; the reporter, seeded without it, is refused the same resolve first, so the gate
 * is proven to be standing rather than open to every door player.
 *
 * `reports:create` refuses a row that is not `active` (`canSeeTarget`), so the author deletes
 * the post *after* the report is filed — the order in which MICA-386 happens in game.
 *
 * Every player is a character micaOS knows offline (`seedCitizen`) and a door player on top of
 * it, as in `glimpse.ts`. A post needs a photo its author owns, planted through `db`.
 */

const GLIMPSE = 'glimpse';
const POSTS = 'mica_glimpse';

/** `Accounts.ts`'s rule, restated so a fixture handle that breaks it fails here, not there. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,32}$/;

interface Refusal {
  error: string;
  key?: string;
}
interface Decision {
  ok: boolean;
  resolution: string;
}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** A refusal with exactly this message and catalog key, as `ServiceEndpoint` answers one. */
const assertRefused = (result: unknown, error: string, key: string, what: string): void => {
  const refusal = result as Refusal | null;
  assert(
    refusal !== null &&
      typeof refusal === 'object' &&
      refusal.error === error &&
      refusal.key === key,
    `${what} answered ${show(result)}; expected { error: ${show(error)}, key: '${key}' }`
  );
};

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────

let handles = 0;

/** A known character and a door player, seeded as an admin only when asked. */
const player = async (label: string, made: string[], admin = false): Promise<string> => {
  const { citizenid } = await seedCitizen(label);
  made.push(citizenid);
  const seeded = await seedPlayer(citizenid, 0, { admin });
  assert(seeded.admin === admin, `the door seeded ${citizenid} as admin ${show(seeded.admin)}`);
  return citizenid;
};

/** A Glimpse account claimed through `accounts:create`, as the player does. */
const glimpseAccount = async (citizenid: string, label: string): Promise<number> => {
  handles += 1;
  const run = citizenid.split('_')[1] ?? 'x';
  const handle = `r_${run}_${handles}_${label}`.slice(0, 32).toLowerCase();
  assert(HANDLE_PATTERN.test(handle), `the fixture handle '${handle}' breaks the handle rule`);
  const { result } = await call<{ id: number; handle: string }>('accounts', 'create', citizenid, {
    app: GLIMPSE,
    handle
  });
  assert(
    Number.isInteger(result?.id) && result.handle === handle,
    `accounts:create for '${handle}' answered ${show(result)}`
  );
  return result.id;
};

let planted = 0;

/** A photo owned by `citizenid`, as the camera's upload would leave one. */
const plantPhoto = async (citizenid: string): Promise<number> => {
  planted += 1;
  return await db.insert(
    'INSERT INTO `mica_media` (`citizenid`, `kind`, `url`, `mime_type`) VALUES (?, ?, ?, ?)',
    [
      citizenid,
      'photo',
      `https://example.invalid/itx/reports-${Date.now()}-${planted}.png`,
      'image/png'
    ]
  );
};

/** A live post through `glimpse:create`, checked against the table. */
const post = async (citizenid: string, account: number, caption: string): Promise<number> => {
  const { result } = await call<{ id: number }>(GLIMPSE, 'create', citizenid, {
    account_id: account,
    caption,
    attachments: [{ photo_id: await plantPhoto(citizenid) }]
  });
  assert(Number.isInteger(result?.id), `glimpse:create answered ${show(result)}, not a post`);
  assert((await postStatus(result.id)) === 'active', `post ${result.id} is not stored active`);
  return result.id;
};

const postStatus = async (id: number): Promise<unknown> =>
  (await db.row(`SELECT \`status\` FROM \`${POSTS}\` WHERE \`id\` = ?`, [id]))?.status;

/** What `glimpse:view` shows `citizenid` of post `id`: the post's id, or null when it is not up. */
const viewed = async (citizenid: string, id: number): Promise<number | null> => {
  const { result } = await call<{ id: number } | null>(GLIMPSE, 'view', citizenid, { id });
  return result ? Number(result.id) : null;
};

/** A report through `reports:create`, filed by `reporter` against post `id`. */
const report = async (reporter: string, id: number): Promise<number> => {
  const { result } = await call<{ id: number; ok?: boolean }>('reports', 'create', reporter, {
    targetTable: POSTS,
    targetId: id,
    category: 'spam'
  });
  assert(Number.isInteger(result?.id), `reports:create answered ${show(result)}, not a report`);
  return result.id;
};

const reportRow = async (id: number): Promise<Record<string, unknown> | null> =>
  await db.row(
    'SELECT `target_table`, `target_id`, `resolution`, `target_prior_status` ' +
      'FROM `mica_reports` WHERE `id` = ?',
    [id]
  );

/**
 * The moderation cycle on one reported post: the reporter is refused a resolve, the admin
 * moderates it (held to `moderated` and to the recorded prior status), the post is gone from
 * the reporter's view, and the admin reopens it. Answers nothing; the caller asserts the end.
 */
const moderateThenReopen = async (
  reporter: string,
  admin: string,
  postId: number,
  reportId: number,
  prior: string
): Promise<void> => {
  const refused = await invoke('reports', 'resolve', reporter, {
    id: reportId,
    action: 'moderate'
  });
  assertRefused(
    refused.result,
    'Not authorised.',
    'server.reports.notAuthorised',
    'a resolve from a door player seeded without the admin flag'
  );
  assert(
    (await reportRow(reportId))?.resolution === 'pending',
    `the refused resolve moved report ${reportId}: ${show(await reportRow(reportId))}`
  );
  assert(
    (await postStatus(postId)) === prior,
    `the refused resolve moved post ${postId} to ${show(await postStatus(postId))}`
  );

  const { result: resolved } = await call<Decision>('reports', 'resolve', admin, {
    id: reportId,
    action: 'moderate'
  });
  assert(
    resolved?.ok === true && resolved.resolution === 'actioned',
    `the admin's resolve answered ${show(resolved)}`
  );
  const actioned = await reportRow(reportId);
  assert(
    actioned?.resolution === 'actioned' &&
      actioned.target_table === POSTS &&
      Number(actioned.target_id) === postId &&
      actioned.target_prior_status === prior,
    `report ${reportId} after the takedown is ${show(actioned)}; expected actioned, prior '${prior}'`
  );
  const down = await postStatus(postId);
  assert(down === 'moderated', `post ${postId} after the takedown is stored ${show(down)}`);
  assert(
    (await viewed(reporter, postId)) === null,
    `glimpse:view still shows post ${postId} after its takedown`
  );

  const { result: reopened } = await call<Decision>('reports', 'reopen', admin, { id: reportId });
  assert(
    reopened?.ok === true && reopened.resolution === 'pending',
    `the admin's reopen answered ${show(reopened)}`
  );
  const back = await reportRow(reportId);
  assert(back?.resolution === 'pending', `report ${reportId} after the reopen is ${show(back)}`);
};

/**
 * Everything a scenario's citizens left. Reports and ledger rows first, by the reporter and the
 * moderator; then accounts, which cascade to their posts; then what is each citizen's own.
 */
const removeAll = async (citizenids: readonly string[]): Promise<void> => {
  for (const citizenid of citizenids) {
    await db.exec('DELETE FROM `mica_reports` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_audit_logs` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_accounts` WHERE `citizenid` = ?', [citizenid]);
    await db.exec(`DELETE FROM \`${POSTS}\` WHERE \`citizenid\` = ?`, [citizenid]);
    await db.exec('DELETE FROM `mica_media` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_notifications` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_phone_numbers` WHERE `citizenid` = ?', [citizenid]);
  }
};

// ─── scenarios ───────────────────────────────────────────────────────────────────────────────

export const reportsScenarios: readonly Scenario[] = [
  {
    // MICA-386: a post reported while up, then deleted by its author, is taken down by an admin
    // and the report reopened. The takedown records `deleted` as what it replaced, and the
    // reopen writes `deleted` back: the post stays gone from the reporter's view and the table,
    // where before the fix it came back `active`.
    id: 'reports-reopen-keeps-an-author-deleted-post-deleted',
    mode: 'standalone',
    tickets: ['MICA-386', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const author = await player('rda', made);
        const reporter = await player('rdr', made);
        const admin = await player('rdm', made, true);
        const account = await glimpseAccount(author, 'rda');
        const postId = await post(author, account, 'reported, then deleted');

        assert(
          (await viewed(reporter, postId)) === postId,
          `glimpse:view does not show the reporter live post ${postId}`
        );
        const reportId = await report(reporter, postId);

        const { result: deleted } = await call<boolean>(GLIMPSE, 'delete', author, {
          id: postId
        });
        assert(deleted === true, `glimpse:delete answered ${show(deleted)}`);
        const gone = await postStatus(postId);
        assert(gone === 'deleted', `the author's delete left post ${postId} ${show(gone)}`);

        await moderateThenReopen(reporter, admin, postId, reportId, 'deleted');

        const after = await postStatus(postId);
        assert(
          after === 'deleted',
          `reopening report ${reportId} put the author-deleted post ${postId} back as ${show(after)}`
        );
        assert(
          (await viewed(reporter, postId)) === null,
          `glimpse:view shows the author-deleted post ${postId} after the reopen`
        );
      } finally {
        await removeAll(made);
      }
    }
  },
  {
    // MICA-386, the other half: a post still up when it is taken down comes back up on the
    // reopen — `active` recorded and written back, and the reporter sees it again. Without this
    // the case above would pass on a reopen that restored nothing at all.
    id: 'reports-reopen-restores-a-live-post',
    mode: 'standalone',
    tickets: ['MICA-386', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const author = await player('rla', made);
        const reporter = await player('rlr', made);
        const admin = await player('rlm', made, true);
        const account = await glimpseAccount(author, 'rla');
        const postId = await post(author, account, 'reported, still up');
        const reportId = await report(reporter, postId);

        await moderateThenReopen(reporter, admin, postId, reportId, 'active');

        const after = await postStatus(postId);
        assert(
          after === 'active',
          `reopening report ${reportId} left the live post ${postId} ${show(after)}`
        );
        assert(
          (await viewed(reporter, postId)) === postId,
          `glimpse:view does not show the restored post ${postId}`
        );
      } finally {
        await removeAll(made);
      }
    }
  }
];
