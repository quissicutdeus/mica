// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario, RunSignal } from '../runner';
import { db } from '../lib/db';
import { call, invoke, pushes, seedPlayer, type PushEnvelope } from '../lib/door';
import { assert, harnessKeys, seedCitizen } from '../lib/mica';
import { openSealed } from '../lib/sealed';
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * Glimpse (MICA-253, `server/services/Glimpse.ts` and `GlimpseComments.ts`) inside a real
 * FXServer on a real MariaDB, driven through the integration door (MICA-397, `../lib/door.ts`),
 * which runs each action's own dispatch as a synthetic player.
 *
 * Beside it, the two declarations Glimpse is wired through: its `reactable` rule (MICA-391),
 * which `accounts:react` and `accounts:reactionsFor` read from the declaration rather than a
 * hand list in Accounts, and its `defineSocialApp` call (MICA-394), which registers Glimpse's DM
 * policy with `dms`. Glimpse's declaration names only `dms` — no account policy and no block
 * handler — so what a block hides in Glimpse is Glimpse's own SQL and the shared `dms` rule,
 * proven here as such, and the registry `defineSocialApp` fed is proven by a DM that `dms`
 * accepts for `glimpse` and refuses for an app nobody registered.
 *
 * Every player is a character micaOS knows offline (`seedCitizen`, a `mica_phone_numbers` row,
 * so no orphan sweep can read its rows as a gone character's) and a door player on top of it.
 * The standalone run sets no `mica_phone_item`, so `glimpse:create`, `glimpse_comments:create`
 * and `dms:send`, all `requirePhoneFor`, pass for a player holding no item.
 *
 * A post needs a photo the poster owns in `mica_media`, and the only way one gets there in game
 * is the camera's upload, which needs a client. So each photo is a row planted through `db`,
 * owned by its citizen, exactly what Media's own `findById(id, citizenid)` reads: the fixture is
 * the photo, and the subject is what Glimpse does with it.
 *
 * Every reply is held to the table, and every table read to a reply.
 */

const GLIMPSE = 'glimpse';
const POSTS = 'mica_glimpse';
const HEART = '❤️';
const THUMBS = '\u{1F44D}';

/** `Accounts.ts`'s rule, restated so a fixture handle that breaks it fails here, not there. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,32}$/;

interface Account {
  id: number;
  handle: string;
}
interface Attachment {
  id: number;
  media: { id: number; kind: string; url?: string };
}
interface Post {
  id: number;
  account_id: number;
  caption: string | null;
  status: string;
  handle?: string;
  attachments?: Attachment[];
  editWindow?: number;
}
interface Page {
  rows: Post[];
  nextCursor: number | null;
}
interface Profile {
  account: { id: number; handle: string } | null;
  rows: Post[];
}
interface Comment {
  id: number;
  post_id: number;
  account_id: number;
  body: string;
  handle?: string;
}
interface Refusal {
  error: string;
  key?: string;
}
interface Reactions {
  counts: Record<string, number>;
  mine: string[];
}
/** The door's envelope, with the two fields `shared/appEvents.ts` carries beside it. */
type Envelope = PushEnvelope & {
  notify?: { title?: string; message?: string };
  deepLink?: string;
  persisted?: boolean;
};

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Which honest path a reply took, printed beside the PASS. */
const branch = (id: string, text: string): void => {
  console.log(`[mica-integration] ${id}: ${text}`);
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

/** Neither the key nor the value: a reply that carries a citizenid anywhere names a character. */
const assertNoCitizen = (value: unknown, citizenids: readonly string[], what: string): void => {
  const text = show(value);
  assert(!text.includes('"citizenid"'), `${what} carries a citizenid key: ${text}`);
  for (const citizenid of citizenids) {
    assert(!text.includes(citizenid), `${what} carries the citizenid ${citizenid}: ${text}`);
  }
};

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────

interface Player {
  citizenid: string;
  account: Account;
}

/** A known character, a door player, and one Glimpse account claimed through `accounts:create`. */
const glimpser = async (label: string, made: string[]): Promise<Player> => {
  const { citizenid } = await seedCitizen(label);
  made.push(citizenid);
  await seedPlayer(citizenid, 0);
  const account = await claim(citizenid, GLIMPSE, label);
  return { citizenid, account };
};

let handles = 0;

/** An account in `app`, claimed as the player does, and checked against the table. */
const claim = async (citizenid: string, app: string, label: string): Promise<Account> => {
  handles += 1;
  // The run's own stamp from the citizenid (`itx_<run>_<n>_…`), so two runs never share one,
  // under a prefix no citizenid has, so a handle in a reply never reads as a leaked citizenid.
  const run = citizenid.split('_')[1] ?? 'x';
  const handle = `g_${run}_${handles}_${label}`.slice(0, 32).toLowerCase();
  assert(HANDLE_PATTERN.test(handle), `the fixture handle '${handle}' breaks the handle rule`);
  const { result } = await call<Account & { app?: string }>('accounts', 'create', citizenid, {
    app,
    handle
  });
  assert(
    Number.isInteger(result?.id) && result.handle === handle && result.app === app,
    `accounts:create for '${handle}' in ${app} answered ${show(result)}`
  );
  const row = await db.row(
    'SELECT `citizenid`, `app`, `status` FROM `mica_accounts` WHERE `id` = ?',
    [result.id]
  );
  assert(
    row?.citizenid === citizenid && row.app === app && row.status === 'active',
    `account ${result.id} is stored as ${show(row)}`
  );
  return { id: result.id, handle };
};

let planted = 0;

/**
 * A media row owned by `citizenid`, as the camera's upload would leave one. The URL names no
 * citizen: it is projected back out to readers, and `assertNoCitizen` reads every reply whole.
 */
const plantMedia = async (
  citizenid: string,
  kind: 'photo' | 'video' = 'photo'
): Promise<number> => {
  planted += 1;
  return await db.insert(
    'INSERT INTO `mica_media` (`citizenid`, `kind`, `url`, `mime_type`) VALUES (?, ?, ?, ?)',
    [
      citizenid,
      kind,
      `https://example.invalid/itx/${Date.now()}-${planted}.${kind === 'photo' ? 'png' : 'mp4'}`,
      kind === 'photo' ? 'image/png' : 'video/mp4'
    ]
  );
};

/** A post through `glimpse:create`, failing on anything but one. */
const post = async (who: Player, caption: string, photos: number[]): Promise<Post> => {
  const { result } = await call<Post>(GLIMPSE, 'create', who.citizenid, {
    account_id: who.account.id,
    caption,
    attachments: photos.map((photo_id) => ({ photo_id }))
  });
  assert(Number.isInteger(result?.id), `glimpse:create answered ${show(result)}, not a post`);
  return result;
};

/** The feed from just above `top`, so the newest rows this scenario wrote lead the page. */
const feed = async (who: Player, top: number, asViewer = true): Promise<Post[]> => {
  const { result } = await call<Page>(GLIMPSE, 'feed', who.citizenid, {
    account_id: asViewer ? who.account.id : null,
    cursor: top + 1,
    limit: 20
  });
  assert(Array.isArray(result?.rows), `glimpse:feed answered ${show(result)}`);
  return result.rows;
};

const ids = (rows: readonly { id: number }[]): number[] => rows.map((row) => Number(row.id));

const react =
  (who: Player | { citizenid: string }, app: string, account: number, target: number) =>
  ({ emoji = HEART, table = POSTS }: { emoji?: string; table?: string } = {}) =>
    invoke<unknown>('accounts', 'react', who.citizenid, {
      app,
      account_id: account,
      target_table: table,
      target_id: target,
      emoji
    });

const reactionRows = async (account: number, target: number, emoji: string): Promise<number> =>
  await db.count(
    'SELECT COUNT(*) FROM `mica_account_reactions` ' +
      'WHERE `account_id` = ? AND `target_table` = ? AND `target_id` = ? AND `emoji` = ?',
    [account, POSTS, target, emoji]
  );

/** Every envelope pushed to `citizenid` until `done` holds of them all, kept rather than dropped. */
const collect = async (
  citizenid: string,
  done: (seen: readonly Envelope[]) => boolean,
  signal: RunSignal,
  what: string
): Promise<Envelope[]> => {
  const seen: Envelope[] = [];
  await eventually(
    async () => {
      seen.push(...((await pushes(citizenid)) as Envelope[]));
      return done(seen) ? true : null;
    },
    5_000,
    signal,
    what
  );
  return seen;
};

/** The notification row a push persisted, once its never-awaited write has landed. */
const notificationRow = async (
  citizenid: string,
  kind: string,
  signal: RunSignal,
  what: string
): Promise<Record<string, unknown>> =>
  await eventually(
    async () => {
      const row = await db.row(
        'SELECT `citizenid`, `device_id`, `app`, `kind`, `title`, `body`, `deep_link` ' +
          'FROM `mica_notifications` ' +
          'WHERE `citizenid` = ? AND `kind` = ? ORDER BY `id` DESC LIMIT 1',
        [citizenid, kind]
      );
      if (!row) return null;
      // The title and body are sealed to the phone the row is on (MICA-431): opened as read,
      // with the key the harness wrote, so every assertion below reads the words.
      const open = (column: 'title' | 'body'): string =>
        openSealed(row[column], harnessKeys(), {
          table: 'mica_notifications',
          column,
          citizenid: String(row.citizenid),
          deviceId: (row.device_id as string | null) ?? null,
          scope: []
        });
      return { ...row, title: open('title'), body: open('body') };
    },
    5_000,
    signal,
    what
  );

/**
 * Everything a scenario's citizens left. Accounts first: posts, comments, attachments, blocks,
 * reactions and DMs all hang off an account by a cascading key. Then what is the citizen's own.
 */
const removeAll = async (citizenids: readonly string[]): Promise<void> => {
  for (const citizenid of citizenids) {
    await db.exec('DELETE FROM `mica_accounts` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_glimpse` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_media` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_notifications` WHERE `citizenid` = ?', [citizenid]);
    await db.exec('DELETE FROM `mica_phone_numbers` WHERE `citizenid` = ?', [citizenid]);
  }
};

// ─── scenarios ───────────────────────────────────────────────────────────────────────────────

export const glimpseScenarios: readonly Scenario[] = [
  {
    // MICA-253: a post carries only its author's own live photos — a stranger's photo, a video
    // and a repeat are dropped — and is refused outright when none survives or the account is
    // not the caller's. The post then reads back to another account, through the feed, the
    // post view and the author's grid, with the author's handle and never their citizenid.
    id: 'glimpse-post-reaches-another-feed-without-its-citizenid',
    mode: 'standalone',
    tickets: ['MICA-253', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const author = await glimpser('gpa', made);
        const reader = await glimpser('gpr', made);
        const photo = await plantMedia(author.citizenid);
        const video = await plantMedia(author.citizenid, 'video');
        const theirs = await plantMedia(reader.citizenid);

        // Refused before any row: no owned photo survives, and an account that is not yours.
        const before = await db.count(`SELECT COUNT(*) FROM \`${POSTS}\` WHERE \`citizenid\` = ?`, [
          author.citizenid
        ]);
        const none = await invoke(GLIMPSE, 'create', author.citizenid, {
          account_id: author.account.id,
          caption: 'nothing of mine',
          attachments: [{ photo_id: theirs }, { photo_id: video }]
        });
        assertRefused(
          none.result,
          'Pick at least one photo to post.',
          'server.glimpse.needsPhoto',
          "a post of a stranger's photo and a video"
        );
        const borrowed = await invoke(GLIMPSE, 'create', author.citizenid, {
          account_id: reader.account.id,
          caption: 'as somebody else',
          attachments: [{ photo_id: photo }]
        });
        assertRefused(
          borrowed.result,
          'That account is not yours.',
          'server.accounts.notYours',
          "a post as another player's account"
        );
        const after = await db.count(`SELECT COUNT(*) FROM \`${POSTS}\` WHERE \`citizenid\` = ?`, [
          author.citizenid
        ]);
        assert(after === before, `two refused posts left ${after - before} row(s) in ${POSTS}`);

        const caption = `golden hour ${author.account.handle}`;
        const created = await post(author, `  ${caption}  `, [photo, theirs, video, photo]);
        assert(created.caption === caption, `the caption came back ${show(created.caption)}`);
        assert(
          created.account_id === author.account.id && created.handle === author.account.handle,
          `the post is attributed as ${show(created)}`
        );
        assert(
          typeof created.editWindow === 'number' && created.editWindow > 0,
          `the create reply's editWindow is ${show(created.editWindow)}`
        );
        const carousel = ids((created.attachments ?? []).map((a) => a.media));
        assert(
          carousel.length === 1 && carousel[0] === photo,
          `the carousel holds media ${show(carousel)}; only the author's photo ${photo} survives`
        );
        assertNoCitizen(created, [author.citizenid], 'the create reply');

        const stored = await db.row(
          `SELECT \`citizenid\`, \`account_id\`, \`caption\`, \`status\` FROM \`${POSTS}\` WHERE \`id\` = ?`,
          [created.id]
        );
        assert(
          stored?.citizenid === author.citizenid &&
            Number(stored.account_id) === author.account.id &&
            stored.caption === caption &&
            stored.status === 'active',
          `post ${created.id} is stored as ${show(stored)}`
        );
        const attached = await db.rows(
          'SELECT `media_id`, `citizenid` FROM `mica_glimpse_attachments` WHERE `post_id` = ?',
          [created.id]
        );
        assert(
          attached.length === 1 &&
            Number(attached[0]?.media_id) === photo &&
            attached[0]?.citizenid === author.citizenid,
          `post ${created.id}'s attachment rows are ${show(attached)}`
        );

        // Another account reads it, three ways.
        const seen = (await feed(reader, created.id)).find((row) => row.id === created.id);
        assert(seen, `the reader's feed from ${created.id + 1} does not hold post ${created.id}`);
        assert(
          seen?.handle === author.account.handle && seen.caption === caption,
          `the reader's feed shows the post as ${show(seen)}`
        );
        assert(
          ids((seen?.attachments ?? []).map((a) => a.media)).join() === String(photo),
          `the feed's carousel is ${show(seen?.attachments)}`
        );
        assertNoCitizen(seen, [author.citizenid, reader.citizenid], 'the feed row');

        const anonymous = await feed(reader, created.id, false);
        assert(
          ids(anonymous).includes(created.id),
          `the unfiltered feed from ${created.id + 1} holds ${show(ids(anonymous))}`
        );

        const { result: viewed } = await call<Post | null>(GLIMPSE, 'view', reader.citizenid, {
          id: created.id
        });
        assert(viewed?.id === created.id, `glimpse:view answered ${show(viewed)}`);
        assertNoCitizen(viewed, [author.citizenid], 'glimpse:view');

        const { result: grid } = await call<Profile>(GLIMPSE, 'profile', reader.citizenid, {
          account_id: author.account.id,
          viewer_account_id: reader.account.id
        });
        assert(
          grid?.account?.id === author.account.id && ids(grid.rows).includes(created.id),
          `the author's grid answered ${show(grid)}`
        );
        assertNoCitizen(grid, [author.citizenid], "the author's grid");
      } finally {
        await removeAll(made);
      }
    }
  },
  {
    // MICA-391, MICA-253: a like is whatever Glimpse's `reactable` declaration allows, read by
    // Accounts from the declaration. ❤️ from a Glimpse account counts, once however often it is
    // sent; another emoji, a table nobody declared, an account claimed in another app, and a
    // post that is no longer up are each refused with the handler's exact answer and write
    // nothing; and `visibleTo` stops a deleted post's likes being counted while its row stays.
    id: 'glimpse-reactions-follow-the-declared-rule',
    mode: 'standalone',
    tickets: ['MICA-391', 'MICA-253', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const author = await glimpser('gra', made);
        const fan = await glimpser('grf', made);
        const elsewhere = await claim(fan.citizenid, 'blabber', 'grb');
        const target = await post(author, 'like me', [await plantMedia(author.citizenid)]);
        const like = react(fan, GLIMPSE, fan.account.id, target.id);

        const liked = await like();
        assert(liked.result === true, `a ❤️ on post ${target.id} answered ${show(liked.result)}`);
        const again = await like();
        assert(again.result === true, `a second ❤️ answered ${show(again.result)}`);
        const hearts = await reactionRows(fan.account.id, target.id, HEART);
        assert(hearts === 1, `two ❤️ from one account left ${hearts} rows, not one`);

        const thumbs = await like({ emoji: THUMBS });
        assertRefused(
          thumbs.result,
          'That cannot be reacted to.',
          'server.accounts.notReactable',
          'a 👍 outside the declared set'
        );
        const thumbRows = await reactionRows(fan.account.id, target.id, THUMBS);
        assert(thumbRows === 0, `a refused 👍 left ${thumbRows} row(s)`);

        const undeclared = await like({ table: 'itx_not_reactable' });
        assertRefused(
          undeclared.result,
          'That cannot be reacted to.',
          'server.accounts.notReactable',
          'a reaction on a table no service declared reactable'
        );

        // `canReact`: the account is real and the caller's, but claimed in Blabber's namespace.
        const crossApp = await react(fan, 'blabber', elsewhere.id, target.id)();
        assertRefused(
          crossApp.result,
          'That content no longer exists.',
          'server.reports.targetGone',
          'a ❤️ on a Glimpse post from a Blabber account'
        );
        const crossRows = await db.count(
          'SELECT COUNT(*) FROM `mica_account_reactions` WHERE `account_id` = ?',
          [elsewhere.id]
        );
        assert(crossRows === 0, `a refused cross-app ❤️ left ${crossRows} row(s)`);

        const counted = async (): Promise<Reactions | undefined> => {
          const { result } = await call<Record<string, Reactions>>(
            'accounts',
            'reactionsFor',
            fan.citizenid,
            { app: GLIMPSE, target_table: POSTS, target_ids: [target.id] }
          );
          return result?.[String(target.id)];
        };
        const live = await counted();
        assert(
          live?.counts?.[HEART] === 1 && live.mine.length === 1 && live.mine[0] === HEART,
          `reactionsFor a live post answered ${show(live)}; expected one ❤️, the fan's own`
        );

        // The post goes, through its own generic delete: soft, so the like's row stays.
        const { result: deleted } = await call<boolean>(GLIMPSE, 'delete', author.citizenid, {
          id: target.id
        });
        assert(deleted === true, `glimpse:delete answered ${show(deleted)}`);
        const status = await db.row(`SELECT \`status\` FROM \`${POSTS}\` WHERE \`id\` = ?`, [
          target.id
        ]);
        assert(status?.status === 'deleted', `the deleted post is stored as ${show(status)}`);

        const late = await like();
        assertRefused(
          late.result,
          'That content no longer exists.',
          'server.reports.targetGone',
          'a ❤️ on a deleted post'
        );
        const gone = await counted();
        assert(
          gone !== undefined && Object.keys(gone.counts).length === 0 && gone.mine.length === 0,
          `reactionsFor a deleted post answered ${show(gone)}; visibleTo should hide its likes`
        );
        const kept = await reactionRows(fan.account.id, target.id, HEART);
        assert(kept === 1, `the deleted post's ❤️ row is ${kept}; hidden, not removed`);
      } finally {
        await removeAll(made);
      }
    }
  },
  {
    // MICA-253: a comment lands under a live post and its author hears `comment`, naming the
    // post, the comment and the commenter, with a notification row behind it and the same deep
    // link on both. An author commenting on their own post is stored and pushes them nothing.
    // A comment's body mentioning a third account pushes that account `mention`.
    id: 'glimpse-comment-lands-and-pushes-the-post-author',
    mode: 'standalone',
    tickets: ['MICA-253', 'MICA-397'],
    run: async (signal) => {
      const id = 'glimpse-comment-lands-and-pushes-the-post-author';
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const author = await glimpser('gca', made);
        const commenter = await glimpser('gcc', made);
        const named = await glimpser('gcm', made);
        const target = await post(author, 'say something', [await plantMedia(author.citizenid)]);
        await pushes(author.citizenid);
        await pushes(named.citizenid);

        const { result: own } = await call<Comment>(
          'glimpse_comments',
          'create',
          author.citizenid,
          {
            account_id: author.account.id,
            post_id: target.id,
            body: 'my own words'
          }
        );
        assert(Number.isInteger(own?.id), `the author's own comment answered ${show(own)}`);

        const body = `nice one @${named.account.handle}`;
        const { result: comment } = await call<Comment>(
          'glimpse_comments',
          'create',
          commenter.citizenid,
          { account_id: commenter.account.id, post_id: target.id, body: `  ${body} ` }
        );
        assert(
          Number.isInteger(comment?.id) &&
            comment.post_id === target.id &&
            comment.account_id === commenter.account.id &&
            comment.body === body &&
            comment.handle === commenter.account.handle,
          `glimpse_comments:create answered ${show(comment)}`
        );
        assertNoCitizen(comment, [commenter.citizenid], 'the comment reply');

        const stored = await db.row(
          'SELECT `citizenid`, `account_id`, `post_id`, `body`, `status` ' +
            'FROM `mica_glimpse_comments` WHERE `id` = ?',
          [comment.id]
        );
        assert(
          stored?.citizenid === commenter.citizenid &&
            Number(stored.account_id) === commenter.account.id &&
            Number(stored.post_id) === target.id &&
            stored.body === body &&
            stored.status === 'active',
          `comment ${comment.id} is stored as ${show(stored)}`
        );

        const isFor = (commentId: number) => (envelope: Envelope) =>
          envelope.event === 'comment' && Number(envelope.payload?.comment_id) === commentId;
        const seen = await collect(
          author.citizenid,
          (all) => all.some(isFor(comment.id)),
          signal,
          `the comment push for comment ${comment.id} to the post's author`
        );
        const push = seen.find(isFor(comment.id)) as Envelope;
        assert(push.app === GLIMPSE, `the comment push is for app '${push.app}'`);
        assert(
          Number(push.payload.post_id) === target.id &&
            push.payload.handle === commenter.account.handle,
          `the comment push carries ${show(push.payload)}`
        );
        assert(
          typeof push.deepLink === 'string' && push.deepLink.includes(`postId=${target.id}`),
          `the comment push's deep link is ${show(push.deepLink)}`
        );
        // Pushed after the author's own comment, so anything it pushed is in `seen` already.
        assert(
          !seen.some(isFor(own.id)),
          `the author's comment on their own post pushed them: ${show(seen)}`
        );
        assert(
          !seen.some((envelope) => envelope.event === 'mention'),
          `the post's author was told twice, a mention beside the comment: ${show(seen)}`
        );

        const row = await notificationRow(
          author.citizenid,
          'comment',
          signal,
          "the comment's notification row"
        );
        assert(
          row.app === GLIMPSE &&
            row.title === `@${commenter.account.handle} commented` &&
            row.deep_link === push.deepLink,
          `the comment's notification row is ${show(row)}; the push linked ${show(push.deepLink)}`
        );

        const mentioned = await collect(
          named.citizenid,
          (all) => all.some((envelope) => envelope.event === 'mention'),
          signal,
          `the mention push to @${named.account.handle}`
        );
        const mention = mentioned.find((envelope) => envelope.event === 'mention') as Envelope;
        assert(
          mention.app === GLIMPSE &&
            Number(mention.payload.post_id) === target.id &&
            mention.payload.handle === commenter.account.handle,
          `the mention push is ${show(mention)}`
        );

        const { result: counts } = await call<Record<string, { comments: number }>>(
          GLIMPSE,
          'engagement',
          commenter.citizenid,
          { ids: [target.id] }
        );
        assert(
          counts?.[String(target.id)]?.comments === 2,
          `glimpse:engagement answered ${show(counts)}; expected 2 comments`
        );
        const { result: thread } = await call<{ rows?: Comment[] }>(
          'glimpse_comments',
          'list',
          named.citizenid,
          { post_id: target.id }
        );
        const listed = ids(thread?.rows ?? []);
        assert(
          listed.includes(own.id) && listed.includes(comment.id) && listed.length === 2,
          `glimpse_comments:list answered ${show(thread)}`
        );
        assertNoCitizen(thread, [author.citizenid, commenter.citizenid], 'the comment thread');
        branch(id, `${seen.length} push(es) to the author, ${mentioned.length} to the mentioned`);
      } finally {
        await removeAll(made);
      }
    }
  },
  {
    // MICA-253: a block in Glimpse. The blocker stops seeing the blocked account in the feed,
    // the post view and its grid, while a third account still sees everything; the blocked
    // account still sees the blocker's posts in its feed, which is Blabber's one-direction rule.
    // Contact ends both ways: neither may comment on or like the other's posts, nor DM them
    // through `dms` under Glimpse's policy, and the third account still may.
    id: 'glimpse-block-hides-the-blocked-and-ends-contact',
    mode: 'standalone',
    tickets: ['MICA-253', 'MICA-391', 'MICA-394', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const blocker = await glimpser('gbv', made);
        const blocked = await glimpser('gba', made);
        const bystander = await glimpser('gbc', made);
        const theirs = await post(blocked, 'from the blocked', [
          await plantMedia(blocked.citizenid)
        ]);
        const mine = await post(blocker, 'from the blocker', [await plantMedia(blocker.citizenid)]);
        const neutral = await post(bystander, 'from the bystander', [
          await plantMedia(bystander.citizenid)
        ]);
        const top = Math.max(theirs.id, mine.id, neutral.id);

        const beforeBlock = ids(await feed(blocker, top));
        assert(
          beforeBlock.includes(theirs.id),
          `before any block the blocker's feed holds ${show(beforeBlock)}, not post ${theirs.id}`
        );

        const { result: done } = await call<boolean>('accounts', 'block', blocker.citizenid, {
          app: GLIMPSE,
          blocker_account_id: blocker.account.id,
          blocked_account_id: blocked.account.id
        });
        assert(done === true, `accounts:block answered ${show(done)}`);
        const held = await db.count(
          'SELECT COUNT(*) FROM `mica_account_blocks` ' +
            "WHERE `blocker_account_id` = ? AND `blocked_account_id` = ? AND `status` = 'active'",
          [blocker.account.id, blocked.account.id]
        );
        assert(held === 1, `the block is ${held} row(s) in mica_account_blocks`);

        // Hidden from the blocker, and only from the blocker.
        const blockerFeed = ids(await feed(blocker, top));
        assert(
          !blockerFeed.includes(theirs.id),
          `the blocker's feed still holds the blocked post ${theirs.id}: ${show(blockerFeed)}`
        );
        assert(
          blockerFeed.includes(neutral.id) && blockerFeed.includes(mine.id),
          `the blocker's feed lost unblocked posts ${neutral.id}/${mine.id}: ${show(blockerFeed)}`
        );
        const bystanderFeed = ids(await feed(bystander, top));
        assert(
          bystanderFeed.includes(theirs.id),
          `the bystander's feed lost post ${theirs.id}: ${show(bystanderFeed)}`
        );
        const blockedFeed = ids(await feed(blocked, top));
        assert(
          blockedFeed.includes(mine.id),
          `the blocked account's feed lost the blocker's post ${mine.id}: ${show(blockedFeed)}`
        );

        const viewAs = async (who: Player) =>
          (await call<Post | null>(GLIMPSE, 'view', who.citizenid, { id: theirs.id })).result;
        const hidden = await viewAs(blocker);
        assert(hidden === null, `glimpse:view of the blocked post answered ${show(hidden)}`);
        const shown = await viewAs(bystander);
        assert(shown?.id === theirs.id, `the bystander's glimpse:view answered ${show(shown)}`);

        const gridAs = async (who: Player) =>
          (
            await call<Profile>(GLIMPSE, 'profile', who.citizenid, {
              account_id: blocked.account.id,
              viewer_account_id: who.account.id
            })
          ).result;
        const blank = await gridAs(blocker);
        assert(
          blank?.account?.id === blocked.account.id && blank.rows.length === 0,
          `the blocked account's grid, to the blocker, is ${show(blank)}; a header and no posts`
        );
        const full = await gridAs(bystander);
        assert(
          ids(full?.rows ?? []).includes(theirs.id),
          `the blocked account's grid, to the bystander, is ${show(full)}`
        );

        // Comments, both ways refused, the bystander's accepted.
        const commentOn = (who: Player, target: Post) =>
          invoke<unknown>('glimpse_comments', 'create', who.citizenid, {
            account_id: who.account.id,
            post_id: target.id,
            body: 'hello'
          });
        for (const [who, target, what] of [
          [blocker, theirs, "the blocker's comment on the blocked post"],
          [blocked, mine, "the blocked account's comment on the blocker's post"]
        ] as const) {
          assertRefused(
            (await commentOn(who, target)).result,
            'You cannot comment on that post.',
            'server.glimpse.cannotComment',
            what
          );
        }
        const stray = await db.count(
          'SELECT COUNT(*) FROM `mica_glimpse_comments` WHERE `account_id` IN (?, ?)',
          [blocker.account.id, blocked.account.id]
        );
        assert(stray === 0, `two refused comments left ${stray} row(s)`);
        const allowed = (await commentOn(bystander, theirs)).result as Comment;
        assert(Number.isInteger(allowed?.id), `the bystander's comment answered ${show(allowed)}`);

        // Likes: `canReact` holds the same block, both ways.
        for (const [who, target, what] of [
          [blocker, theirs, "the blocker's ❤️ on the blocked post"],
          [blocked, mine, "the blocked account's ❤️ on the blocker's post"]
        ] as const) {
          assertRefused(
            (await react(who, GLIMPSE, who.account.id, target.id)()).result,
            'That content no longer exists.',
            'server.reports.targetGone',
            what
          );
        }
        const strayLikes = await db.count(
          'SELECT COUNT(*) FROM `mica_account_reactions` WHERE `account_id` IN (?, ?)',
          [blocker.account.id, blocked.account.id]
        );
        assert(strayLikes === 0, `two refused likes left ${strayLikes} row(s)`);
        const bystanderLike = await react(bystander, GLIMPSE, bystander.account.id, theirs.id)();
        assert(
          bystanderLike.result === true,
          `the bystander's ❤️ answered ${show(bystanderLike.result)}`
        );

        // DMs under Glimpse's policy: refused across the block in either direction.
        const dm = (from: Player, to: Player) =>
          invoke<unknown>('dms', 'send', from.citizenid, {
            app: GLIMPSE,
            account_id: from.account.id,
            peer_account_id: to.account.id,
            body: 'still there?'
          });
        for (const [from, to, what] of [
          [blocked, blocker, 'a DM from the blocked account to the blocker'],
          [blocker, blocked, 'a DM from the blocker to the blocked account']
        ] as const) {
          assertRefused(
            (await dm(from, to)).result,
            "You can't message this account.",
            'server.blabberDms.blocked',
            what
          );
        }
        const strayDms = await db.count(
          'SELECT COUNT(*) FROM `mica_blabber_dms` WHERE `from_account` IN (?, ?)',
          [blocker.account.id, blocked.account.id]
        );
        assert(strayDms === 0, `two refused DMs left ${strayDms} row(s)`);
        const bystanderDm = (await dm(bystander, blocked)).result as { id?: unknown };
        assert(
          Number.isInteger(bystanderDm?.id),
          `the bystander's DM to the blocked account answered ${show(bystanderDm)}`
        );
      } finally {
        await removeAll(made);
      }
    }
  },
  {
    // MICA-394: Glimpse's `defineSocialApp` call is what lets `dms` carry Glimpse DMs. A DM
    // between two Glimpse accounts is accepted and stored, the recipient hears `dm` on Glimpse's
    // own channel with the notification Glimpse's policy wrote — `@handle` and a deep link
    // opening the thread by the sender's handle — and reads it back through the same registry.
    // Its negative twin: an app no declaration registered is refused before any account read.
    id: 'glimpse-dm-policy-is-the-declared-one',
    mode: 'standalone',
    tickets: ['MICA-394', 'MICA-253', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const made: string[] = [];
      try {
        const sender = await glimpser('gds', made);
        const recipient = await glimpser('gdr', made);
        await pushes(recipient.citizenid);
        const text = `hi from @${sender.account.handle}`;

        const { result: sent } = await call<{
          id: number;
          from_account: number;
          to_account: number;
          body: string;
        }>('dms', 'send', sender.citizenid, {
          app: GLIMPSE,
          account_id: sender.account.id,
          peer_account_id: recipient.account.id,
          body: text
        });
        assert(
          Number.isInteger(sent?.id) &&
            sent.from_account === sender.account.id &&
            sent.to_account === recipient.account.id &&
            sent.body === text,
          `a Glimpse DM answered ${show(sent)}`
        );
        assertNoCitizen(sent, [sender.citizenid, recipient.citizenid], 'the DM reply');
        const stored = await db.row(
          'SELECT `citizenid`, `from_account`, `to_account` FROM `mica_blabber_dms` WHERE `id` = ?',
          [sent.id]
        );
        assert(
          stored?.citizenid === sender.citizenid &&
            Number(stored.from_account) === sender.account.id &&
            Number(stored.to_account) === recipient.account.id,
          `DM ${sent.id} is stored as ${show(stored)}`
        );

        const isDm = (envelope: Envelope) =>
          envelope.event === 'dm' &&
          Number(envelope.payload?.peer_account_id) === sender.account.id;
        const seen = await collect(
          recipient.citizenid,
          (all) => all.some(isDm),
          signal,
          `the dm push to @${recipient.account.handle}`
        );
        const push = seen.find(isDm) as Envelope;
        assert(push.app === GLIMPSE, `the DM was pushed on app '${push.app}', not Glimpse's own`);
        assert(
          push.payload.handle === sender.account.handle,
          `the DM push carries ${show(push.payload)}`
        );
        assert(
          push.notify?.title === `@${sender.account.handle}` && push.notify.message === text,
          `the DM push's notification is ${show(push.notify)}; Glimpse's policy writes ` +
            `'@${sender.account.handle}' and the text`
        );
        const link = `${GLIMPSE}?dmHandle=${encodeURIComponent(sender.account.handle)}`;
        assert(push.deepLink === link, `the DM push links ${show(push.deepLink)}, not '${link}'`);

        const row = await notificationRow(
          recipient.citizenid,
          'dm',
          signal,
          "the DM's notification"
        );
        assert(
          row.app === GLIMPSE && row.title === `@${sender.account.handle}` && row.body === '',
          `the DM's notification row is ${show(row)}; Glimpse's title and an empty body`
        );
        assert(row.deep_link === link, `the DM's notification row links ${show(row.deep_link)}`);

        const { result: thread } = await call<{ rows?: { id: number; body: string }[] }>(
          'dms',
          'get',
          recipient.citizenid,
          { app: GLIMPSE, account_id: recipient.account.id, peer_account_id: sender.account.id }
        );
        const read = thread?.rows?.find((message) => message.id === sent.id);
        assert(read?.body === text, `the recipient's thread answered ${show(thread)}`);
        assertNoCitizen(thread, [sender.citizenid, recipient.citizenid], "the recipient's thread");

        const unregistered = await invoke('dms', 'send', sender.citizenid, {
          app: 'itx_no_social_app',
          account_id: sender.account.id,
          peer_account_id: recipient.account.id,
          body: text
        });
        assertRefused(
          unregistered.result,
          "This app doesn't support direct messages.",
          'server.dms.noPolicy',
          'a DM under an app no declaration registered'
        );
        const count = await db.count(
          'SELECT COUNT(*) FROM `mica_blabber_dms` WHERE `from_account` = ?',
          [sender.account.id]
        );
        assert(count === 1, `the sender has ${count} DM row(s), not the one Glimpse DM`);
      } finally {
        await removeAll(made);
      }
    }
  }
];
