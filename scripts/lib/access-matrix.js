// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The cross-citizen access matrix (MICA-464), driven by `test-endpoints.js` against MariaDB.
 *
 * AGENTS.md §2.9: a row id is never authorization alone. Until this file that was proven by
 * about sixteen hand-written suites, so a service or an action was covered only once somebody
 * wrote its test. Here the list of cases is whatever the loaded server registered:
 *
 * - **the actions**: every `mica:server:*` event a client can reach (`onNet`), split as
 *   `hostilePayloads.test.ts` splits them (MICA-463) into the generic CRUD an endpoint derives
 *   from a `defineService` declaration, the custom actions a contract declares, and the raw
 *   handlers, which take no row id and are pinned as such;
 * - **the row ids each takes**: a generic `update` and `delete` take their own table's `id`, a
 *   generic `get` reads the caller's rows, and a generic `create` or `update` takes any
 *   client-writable column named as an id; a custom action's id fields are read off its
 *   contract's input schema, named as 463 names them (`id`, `…Id`, `…_id`, and the items of
 *   `ids`, `…Ids`, `…_ids`). A union or tuple with an id inside, or an input with no recorded
 *   shape, fails the run rather than being skipped;
 * - **the table each id names**: the service's own, from its declaration, for `id` and `ids`;
 *   by the field's name otherwise (`SLOT_TABLES`); and for a `target_table` field, once per
 *   table that opted in with `reactable` on its declaration.
 *
 * **A case is one id field of one action.** The victim earns a row of that table through the
 * shipped handlers (`PRODUCERS` — a create action, a text, a call, another resource's export;
 * nothing is inserted behind them). Every other id field holds the sender's own rows, or a third
 * party's where the field names somebody else on purpose. Then, in this order:
 *
 * 1. **The attack.** A second citizen sends the action naming the victim's row. Every `mica_*`
 *    table is read whole before and after, and nothing may change but the attacker's own rows —
 *    theirs before and after, naming the victim's row in no column. The victim's row, any other
 *    row, a membership row the attacker would be added by: none. Neither the reply nor any push
 *    the attacker is sent may carry anything of the victim's that is not public (`secretsOf`):
 *    the private marker in every non-public row they wrote, their citizenid and license, and
 *    the value of every `private` text column on a public table they hold. The attack sends the
 *    victim no push at all, but the timer pushes every player gets (`AMBIENT_PUSHES`). A
 *    refusal before the action's own code ran (the rate limiter, a missing character) is a
 *    failure of the matrix, never a refusal.
 * 2. **The positive control.** The victim — or, on a membership table, a member who did not
 *    create the row, which is the "a member is answered" half — sends the same action with the
 *    same shape about the same row. It must touch that row (change it, or write a row naming it),
 *    answer with the victim's marker or the row, or be answered where the attack was refused.
 *    Without it a refusal can come from a bad shape or a missing row and pass vacuously. An
 *    attacker answered exactly as the control was, where the control's answer is all that shows
 *    it, is not refused at all.
 *
 * A field that names somebody else's row on purpose — following an account, reacting to a public
 * post — is by design: derived from the declaration where it can be (a public read; a reaction to
 * a public table's row), pinned in `CASES` with why where it cannot. The attacker is answered —
 * with evidence: a row written naming the victim's, an answer carrying it or their public
 * marker, or at least something non-empty — no row the victim held before changed or went, and
 * nothing private of theirs reached the attacker, in the reply or a push.
 *
 * Every case that cannot be driven is in `CASES` with `undrivable` and its reason, and the set is
 * pinned both ways, as are the counts per shape: a new action with an id field fails here until
 * its table is mapped, has a producer, or is pinned. A new service's generic actions are mapped
 * by its declaration and produced by its generic `create`, so they are attacked and controlled
 * with no edit here; only the pinned counts move, which is the point of pinning them.
 *
 * **What this does not prove.** That a refusal is the right refusal, or that its message is: it
 * proves nothing of the victim's changed and nothing private of theirs was answered. A field not
 * named as an id (`reply_to`, `mouth_of` on a blab) is not a case, exactly as in 463. And the
 * device axis: each party holds one phone, so on a device-owned table the `device_id` predicate
 * and the `citizenid` one refuse together here, and either alone would pass.
 */

/** The three parties, and an admin for the staff-only actions. Never in `PEOPLE`. */
export const MATRIX_PEOPLE = {
  victim: {
    src: 31,
    name: 'Vera Matrix',
    license: 'license:' + 'e5'.repeat(20),
    citizenid: 'CIT_V464',
    phone: '5550031',
    bank: 100000,
    job: 'unemployed',
    mark: 'vmark',
    pub: 'vpub'
  },
  attacker: {
    src: 32,
    name: 'Xan Matrix',
    license: 'license:' + 'f6'.repeat(20),
    citizenid: 'CIT_X464',
    phone: '5550032',
    bank: 100000,
    // Staff of the qb job line, so a line's door is open to them and the id is what is judged.
    job: 'police',
    mark: 'xmark',
    pub: 'xpub'
  },
  member: {
    src: 33,
    name: 'Mira Matrix',
    license: 'license:' + 'c7'.repeat(20),
    citizenid: 'CIT_M464',
    phone: '5550033',
    bank: 100000,
    job: 'unemployed',
    mark: 'mmark',
    pub: 'mpub'
  },
  admin: {
    src: 34,
    name: 'Ada Matrix',
    license: 'license:' + 'a8'.repeat(20),
    citizenid: 'CIT_A464',
    phone: '5550034',
    bank: 100000,
    job: 'unemployed',
    mark: 'amark',
    pub: 'apub'
  }
};

/** The matrix's job line, staffed by the police: the attacker, on qb. */
const LINE = '5550464';

/** Somebody other than `who`, for a field that names another party on purpose. */
const THIRD = { victim: 'member', attacker: 'member', member: 'admin', admin: 'member' };

const PREFIX = 'mica:server:';
const GENERIC = new Set(['get', 'create', 'update', 'delete']);
const ID_FIELD = /(^id$|Id$|_id$)/;
const ID_LIST = /(^ids$|Ids$|_ids$)/;

/** A 1×1 PNG: `media.data` takes an inline image and nothing else (MICA-339). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The refusals that happen before an action's own code runs, and so prove nothing about it. */
const PRE_VALIDATION_KEYS = new Set([
  'server.rateLimited',
  'server.notAuthenticated',
  'server.device.unsupported',
  'server.endpoint.appDisabled',
  'server.phone.notHeld'
]);

/** The table an id field names, by the field's own name. `id` and `ids` are the service's. */
const SLOT_TABLES = {
  account_id: 'mica_accounts',
  blocker_account_id: 'mica_accounts',
  blocked_account_id: 'mica_accounts',
  follower_account_id: 'mica_accounts',
  followee_account_id: 'mica_accounts',
  peer_account_id: 'mica_accounts',
  viewer_account_id: 'mica_accounts',
  photo_id: 'mica_media',
  mediaId: 'mica_media',
  conversation_id: 'mica_messages_conversations',
  channel_id: 'mica_darkchat',
  message_id: 'mica_messages',
  reply_to_id: 'mica_messages',
  blab_id: 'mica_blabber',
  anchorId: 'mica_blabber',
  post_id: 'mica_glimpse',
  round_id: 'mica_casino_rounds',
  profile_id: 'mica_spark',
  match_id: 'mica_spark_matches',
  contact_ids: 'mica_contacts'
};

/**
 * What a field's value is where the synthesized one would be refused for its own reasons. A
 * function is called with the sender and the case. Only what a name means is written here.
 */
const FIELD_VALUES = {
  'accounts:*.app': (who, c) => c.appOfTarget ?? 'blabber',
  'accounts:*.emoji': (who, c) => c.emoji ?? '👍',
  'messages:*.emoji': () => '👍',
  'dms:*.app': () => 'blabber',
  'blabber:create.body': (who, c, text) => text(who, 'mica_blabber'),
  'glimpse:create.caption': (who, c, text) => text(who, 'mica_glimpse'),
  'media:thumbnail.thumbnail': () => PNG,
  'reports:create.targetTable': () => 'mica_blabber',
  'reports:resolve.action': () => 'dismiss',
  'spark:swipe.verdict': () => 'like',
  'conversations:update.name': (who, c, text) => text(who, 'mica_messages_conversations'),
  'jobs:*.number': () => LINE
};

/**
 * Per case, by `<service>:<action>.<field>` (or `<service>:<action>` for a generic `get`), where
 * the declarations do not say enough. Each entry says why. A key may also be every field of an
 * action (`<service>:<action>.*`) or of a service (`<service>:*`), one reactable table's variant
 * (`…@mica_glimpse`), or one shape's (`…@standalone`); the narrower wins.
 *
 * - `table`: the table the field names, where its name does not say.
 * - `row`: how the victim's row is made, where the table's producer would not make the right one.
 * - `needs`: a table the attacker and the control's sender each need a row of first.
 * - `complete`: the payload finished from the victim's row (a member's handle in their channel).
 * - `before` / `after`: what is done around the case, so the control has something to show.
 * - `undo`: the counterpart sent after, so the case leaves nothing standing for later ones.
 * - `last`: run after every other case, because what it leaves cannot be undone.
 * - `byDesign`: the field names somebody else's row on purpose.
 * - `controlBy`: who answers the positive control, when it is not the row's creator (or, on a
 *   membership table, a member).
 * - `state`: what is done to the row first, by its creator, for the action to apply to it.
 * - `prepare`: the counterpart sent first by the control's sender with the control's payload —
 *   an unfollow needs a follow to undo — so the control has something to change.
 * - `parent`: the control names the row's own parent here (`[field, table, column]`), where the
 *   attack names the attacker's own: a reply is written into the thread its message is in.
 * - `controlRow`: the control names a different row of the victim's, produced so (`why` says why).
 * - `accepts`: what else counts as the control being answered, with why.
 * - `undrivable`: why this case is not driven, optionally only on some shapes.
 */
const CASES = {
  // `<service>:<action>.*` applies to every field of the action.
  'accounts:unreact.*': {
    prepare: ['accounts', 'react'],
    why: 'an unreact needs a reaction to take off'
  },
  'accounts:unblock.*': { prepare: ['accounts', 'block'], why: 'an unblock needs a block to lift' },
  'accounts:unfollow.*': {
    prepare: ['accounts', 'follow'],
    why: 'an unfollow needs a follow to undo'
  },
  'blabber:unear.*': { prepare: ['blabber', 'ear'], why: 'an unear needs an ear to undo' },
  'accounts:block.*': {
    undo: ['accounts', 'unblock'],
    why: 'a block left standing would refuse the DMs and ears later cases send between the same accounts'
  },
  'spark:*': { needs: 'mica_spark', why: 'nobody swipes or blocks without a profile of their own' },
  'dms:read.account_id': {
    before: async ({ call, accountOf }) =>
      call('member', 'dms', 'send', {
        app: 'blabber',
        account_id: await accountOf('member', 'blabber'),
        peer_account_id: await accountOf('victim', 'blabber'),
        body: 'mmark unread'
      }),
    why: 'reading marks what the other end sent, so the other end sends first'
  },
  'accounts:reactionsFor.target_ids[0]@mica_blabber_dms': {
    before: async ({ call, accountOf, rowId }) =>
      call('victim', 'accounts', 'react', {
        app: 'blabber',
        account_id: await accountOf('victim', 'blabber'),
        target_table: 'mica_blabber_dms',
        target_id: rowId,
        emoji: '👍'
      }),
    why: 'a reaction for the read to answer with'
  },
  'accounts:block.blocked_account_id': { byDesign: 'blocking another account is the feature' },
  'accounts:unblock.blocked_account_id': { byDesign: 'unblocking another account is the feature' },
  'accounts:follow.followee_account_id': { byDesign: 'following another account is the feature' },
  'accounts:unfollow.followee_account_id': { byDesign: 'unfollowing one is the feature' },
  'accounts:followers.account_id': { byDesign: "an account's followers are public" },
  'accounts:following.account_id': { byDesign: 'whom an account follows is public' },
  'accounts:follows.account_id': { byDesign: 'whether one account follows another is public' },
  'blabber:ear.blab_id': { byDesign: "earing somebody's blab is the feature" },
  'blabber:unear.blab_id': { byDesign: 'un-earing it is the feature' },
  'blabber:engagement.ids[0]': { byDesign: "a blab's counts are public" },
  'blabber:profile.account_id': { byDesign: 'a profile is public' },
  'blabber:view.id': { byDesign: 'a blab is public' },
  'blabber:view.anchorId': {
    byDesign: 'a blab is public',
    same: ['id'],
    why: 'an anchor is a blab in the thread opened, so the thread opened is the same blab'
  },
  'dms:send.peer_account_id': { byDesign: 'writing to another account is the feature' },
  'dms:get.peer_account_id': {
    byDesign: "the caller's own thread with that account; the other end is theirs to name",
    before: (ctx) => dmToAttacker(ctx),
    why: 'the victim writes to the attacker first, so the thread has something to answer with'
  },
  'dms:read.peer_account_id': {
    byDesign: "the caller's own thread with that account; the other end is theirs to name",
    before: (ctx) => dmToAttacker(ctx),
    mayChange: ['mica_blabber_dms.read_at'],
    why: 'the victim writes to the attacker first, so reading it marks something read; a DM is its sender’s row, and its `read_at` is the recipient’s to set'
  },
  'glimpse:engagement.ids[0]': { byDesign: "a post's counts are public" },
  'glimpse:profile.account_id': { byDesign: 'a profile is public' },
  'glimpse:view.id': { byDesign: 'a post is public' },
  'glimpse_comments:create.post_id': { byDesign: "commenting on somebody's post is the feature" },
  'glimpse_comments:list.post_id': {
    byDesign: "a post's comments are public",
    before: async ({ call, accountOf, rowId }) =>
      call('victim', 'glimpse_comments', 'create', {
        account_id: await accountOf('victim', 'glimpse'),
        post_id: rowId,
        body: 'vpub comment'
      }),
    why: 'a comment of the victim’s on the post, so the public read has one to answer with'
  },
  'marketplace:view.id': {
    byDesign: 'a listing is public',
    discloses: ['seller_phone'],
    why: '`view` hands out the number the listing was posted from as its contact, on purpose (MICA-284); the feed and search never do'
  },
  'reports:create.targetId': {
    table: 'mica_blabber',
    byDesign: "reporting somebody's content is the feature; the report row is the reporter's"
  },
  'spark:swipe.profile_id': { byDesign: "swiping on somebody's profile is the feature" },
  'spark:block.profile_id': {
    byDesign: "blocking somebody's profile is the feature",
    answer: (attack) =>
      attack.changes.some((ch) => ch.change === 'added' && ch.table === 'mica_account_blocks'),
    last: true,
    why: 'Spark has no unblock, and a blocked profile is gone to the blocker for every later swipe'
  },
  'places:startSharing.contact_ids[0]': {
    row: async ({ call, phoneOf }) => {
      const phone = await phoneOf('member');
      const mine = (await call('victim', 'contacts', 'get', {})).find((x) => x.phone === phone);
      if (mine) return mine.id;
      const made = await call('victim', 'contacts', 'create', { firstname: 'vmark', phone });
      return made.id;
    },
    why: "a location is shared with a contact who is a player; the victim's contact is the member"
  },
  'messages:get.id': { table: 'mica_messages_conversations' },
  'conversations:archive.id': { table: 'mica_messages_conversations' },
  'conversations:delete.id': { table: 'mica_messages_conversations' },
  'conversations:read.id': { table: 'mica_messages_conversations' },
  'messages:react.message_id': { controlBy: 'member', why: 'any member reacts to a message' },
  'messages:unreact.message_id': {
    controlBy: 'member',
    prepare: ['messages', 'react'],
    why: 'any member takes off their own reaction, which they put on first'
  },
  'messages:reactionsFor.target_ids[0]': {
    table: 'mica_messages',
    controlBy: 'member',
    before: ({ call, rowId }) =>
      call('member', 'messages', 'react', { message_id: rowId, emoji: '👍' }),
    why: "a message's reactions are its thread's members', and one reacts first so there is one"
  },
  'conversations:update.id': {
    controlBy: 'victim',
    why: "a group's name is its creator's to change; members are answered on the thread's other actions"
  },
  'messages:send.reply_to_id': {
    parent: ['conversation_id', 'mica_messages', 'conversation_id'],
    why: 'a reply is written into the thread its message is in'
  },
  'darkchat:code.channel_id': { controlBy: 'victim', why: "a channel's code is its owner's" },
  'darkchat:rotateCode.channel_id': {
    controlBy: 'victim',
    why: 'rotating the code is the owner’s'
  },
  'darkchat:removeMember.channel_id': {
    controlBy: 'victim',
    complete: async ({ call, rowId }, payload) => {
      const members = await call('victim', 'darkchat', 'members', { channel_id: rowId });
      return { ...payload, member_id: members.find((m) => m.alias === 'mmark')?.id };
    },
    why: 'removing a member is the owner’s; the member removed is the one who joined'
  },
  'darkchat:removeMember.member_id': {
    undrivable: 'a member’s handle, not a row id; the action’s channel_id is driven with a real one'
  },
  'notes:restore.id': { state: 'deleted' },
  'contacts:restore.id': { state: 'deleted' },
  'media:restore.id': { state: 'deleted' },
  'notifications:restoreNotifications.ids[0]': { state: 'cleared' },
  'reports:resolve.id': { controlBy: 'admin', why: 'staff resolve a report, and nobody else' },
  'reports:reopen.id': {
    controlBy: 'admin',
    state: 'resolved',
    why: 'staff reopen a resolved report, and nobody else'
  },
  'reports:versions.id': { controlBy: 'admin', why: "staff read a report's history" },
  'invoices:pay.id': {
    accepts: (reply) => reply?.reason === 'insufficient_funds',
    why: 'standalone has no money: the owner is answered "insufficient funds", past the ownership check, where the attacker is answered "unknown invoice"'
  },
  'casino:crashCashout.round_id': {
    undrivable: 'standalone has no money, so nobody can start a round to cash out',
    shapes: ['standalone']
  },
  'jobs:lineThread.conversation_id': {
    controlBy: 'attacker',
    controlRow: 'lineThread',
    why: "the door is the line's staff, so the twin is the same staff naming a thread the victim opened with the line, where the attack names the victim's private one"
  },
  'jobs:lineReply.conversation_id': {
    controlBy: 'attacker',
    controlRow: 'lineThread',
    why: "the door is the line's staff, so the twin is the same staff naming a thread the victim opened with the line, where the attack names the victim's private one"
  },
  'conversations:get.cursor.id': {
    undrivable: 'a paging position, not a row to act on: it narrows the caller’s own list'
  },
  'music:broadcastStart.videoId': { undrivable: 'a YouTube id, not a row id' },
  'music:broadcastStart.playlistId': { undrivable: 'a YouTube id, not a row id' },
  'notifications:clearAllNotifications.appId': {
    undrivable: 'an app’s id, not a row id; it narrows the caller’s own rows'
  }
};

/** A DM from the victim to the attacker: theirs to read, so it carries a public marker. */
const dmToAttacker = async ({ call, accountOf }) =>
  call('victim', 'dms', 'send', {
    app: 'blabber',
    account_id: await accountOf('victim', 'blabber'),
    peer_account_id: await accountOf('attacker', 'blabber'),
    body: 'vpub to you'
  });

/** The victim blocks the member's account in `app`, so the victim's own view differs. */
const viewerTwin = (app) => ({
  before: async ({ call, accountOf }) =>
    call('victim', 'accounts', 'block', {
      app,
      blocker_account_id: await accountOf('victim', app),
      blocked_account_id: await accountOf('member', app)
    }),
  after: async ({ call, accountOf }) =>
    call('victim', 'accounts', 'unblock', {
      app,
      blocker_account_id: await accountOf('victim', app),
      blocked_account_id: await accountOf('member', app)
    }),
  why: "a view as an account differs from anybody's only by what that account did; the victim blocks the member, so a view that honoured a stolen viewer would match the victim's"
});
for (const [label, app] of [
  ['blabber:feed.account_id', 'blabber'],
  ['blabber:profile.viewer_account_id', 'blabber'],
  ['glimpse:feed.account_id', 'glimpse'],
  ['glimpse:profile.viewer_account_id', 'glimpse'],
  ['accounts:follows.viewer_account_id', 'blabber']
]) {
  CASES[label] = { ...CASES[label], ...viewerTwin(app) };
}

/** On standalone nobody holds a job, so a job line has no staff and its door opens to nobody. */
for (const label of ['jobs:lineThread.conversation_id', 'jobs:lineReply.conversation_id']) {
  CASES[`${label}@standalone`] = {
    undrivable: 'standalone has no jobs, so no job line has staff to open its door'
  };
}

/**
 * Pushes every player is sent on a timer, whoever did what: never the attacker's doing, so never
 * counted as a push the attack sent the victim. Still read for a leak like any other.
 */
const AMBIENT_PUSHES = {
  'mica:client:signal:set': '`Signal.ts` polls every player’s signal on an interval',
  'mica:client:battery:set': '`Battery.ts` ticks every player’s battery on an interval'
};

/** Raw `onNet` handlers — what a client reaches outside an endpoint. None takes a row id. */
export const RAW_HANDLERS = {
  'mica:server:admin:setBattery': "a source's battery level, admin-only; no row id",
  'mica:server:battery:load': 'no payload; the caller’s own battery',
  'mica:server:contacts:share': 'a contact card for whoever stands nearby; no row id',
  'mica:server:phone:answer': 'no payload; the caller’s own ringing call',
  'mica:server:phone:end': 'no payload; the caller’s own call',
  'mica:server:phone:simulateIncoming': 'a dev aid; a number, not a row id',
  'mica:server:phone:start': 'a phone number, not a row id',
  'mica:server:shell:checkDeviceItem': 'no row id; the caller’s own inventory',
  'mica:server:shell:setOpen': 'a boolean or `{ device, open }`; no row id'
};

/** Per shape, exactly. A new id field moves these, on purpose: decide its case, then the count. */
export const MATRIX_COUNTS = {
  standalone: {
    cases: 131,
    refused: 94,
    stripped: 3,
    silent: 18,
    byDesign: 29,
    controls: 94,
    memberControls: 16,
    undrivable: 8
  },
  qb: {
    cases: 131,
    refused: 97,
    stripped: 3,
    silent: 18,
    byDesign: 29,
    controls: 97,
    memberControls: 16,
    undrivable: 5
  }
};

/* ------------------------------------------------------------------ helpers */

const isIdPath = (path) => {
  const last = path.at(-1);
  if (typeof last === 'number') {
    const list = path.at(-2);
    return typeof list === 'string' && ID_LIST.test(list);
  }
  return typeof last === 'string' && ID_FIELD.test(last);
};

const pathLabel = (path) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');

const fieldName = (path) => {
  const last = path.at(-1);
  return typeof last === 'number' ? path.at(-2) : last;
};

const setAt = (root, path, value) => {
  const [head, ...rest] = path;
  const base = Array.isArray(root) ? [...root] : { ...root };
  if (rest.length === 0) {
    base[head] = value;
    return base;
  }
  const next = root?.[head] ?? (typeof rest[0] === 'number' ? [] : {});
  base[head] = setAt(next, rest, value);
  return base;
};

/** Whether a reply names this row, as an object's `id`. */
const namesRow = (json, id) => new RegExp(`"id":${id}[,}]`).test(json);

/** A non-empty answer: a list with something in it, or a count above zero. */
const answersSomething = (reply) =>
  (Array.isArray(reply) && reply.length > 0) ||
  (Array.isArray(reply?.rows) && reply.rows.length > 0) ||
  (reply !== null &&
    typeof reply === 'object' &&
    Object.values(reply).some((v) => typeof v === 'number' && v > 0));

const isFailure = (reply) =>
  reply === false ||
  reply === null ||
  reply === undefined ||
  (typeof reply === 'object' &&
    (reply.error !== undefined || reply.ok === false || reply.success === false));

/* ------------------------------------------------------------------ the run */

export const runAccessMatrix = async (shape, { check, step }) => {
  const { kind } = shape;
  const b = shape.bundle();
  const P = MATRIX_PEOPLE;
  const cid = (who) => shape.citizenOf(P[who]);

  /* ---- the parties */
  step(`${kind}: matrix — four more players connect`);
  for (const who of Object.keys(P)) {
    const person = P[who];
    if (kind === 'qb') {
      await shape.rows('INSERT IGNORE INTO players (citizenid, charinfo) VALUES (?, ?)', [
        person.citizenid,
        JSON.stringify({
          firstname: person.name.split(' ')[0],
          lastname: 'Matrix',
          phone: person.phone
        })
      ]);
    }
    await shape.connect(person.src, person);
    // Somewhere, so an action that reads the caller's position (a saved place) finds one.
    shape.runtime.placePlayer(person.src, [100 + person.src, 200, 30]);
  }
  shape.runtime.grantAce(P.admin.src, 'mica.admin');
  const phoneOf = (who) => shape.numberOf(P[who]);

  const call = async (who, service, action, data) => {
    b.__resetRateLimits();
    return shape.call(P[who].src, service, action, data);
  };

  /* ---- the database, read whole */
  const tables = (await shape.rows("SHOW TABLES LIKE 'mica\\_%'"))
    .map((r) => Object.values(r)[0])
    .filter((t) => t !== 'mica_audit_logs' && t !== 'mica_schema_migrations')
    .sort();
  const keys = {};
  for (const t of tables) {
    keys[t] = (await shape.rows(`SHOW KEYS FROM \`${t}\` WHERE Key_name = 'PRIMARY'`)).map(
      (k) => k.Column_name
    );
  }
  // A range of its own for each table, so an id names one table and a wrong mapping fails its
  // control rather than landing on a row of another table that happens to share the number.
  for (const [i, t] of tables.entries()) {
    if (keys[t].length === 1 && keys[t][0] === 'id') {
      await shape.rows(`ALTER TABLE \`${t}\` AUTO_INCREMENT = ${(i + 1) * 100000}`);
    }
  }
  const snapshot = async () => {
    const out = {};
    for (const t of tables) {
      const rows = await shape.rows(`SELECT * FROM \`${t}\``);
      out[t] = new Map(
        rows.map((row) => [
          keys[t].length ? keys[t].map((k) => String(row[k])).join('|') : JSON.stringify(row),
          row
        ])
      );
    }
    return out;
  };
  const diff = (before, after) => {
    const changes = [];
    for (const t of tables) {
      for (const [key, row] of before[t]) {
        const now = after[t].get(key);
        if (!now) changes.push({ table: t, key, change: 'removed', row });
        else if (JSON.stringify(now) !== JSON.stringify(row)) {
          changes.push({ table: t, key, change: 'changed', row, now });
        }
      }
      for (const [key, row] of after[t]) {
        if (!before[t].has(key)) changes.push({ table: t, key, change: 'added', row });
      }
    }
    return changes;
  };
  const describe = (changes) =>
    changes
      .slice(0, 4)
      .map((c) => `${c.change} ${c.table}#${c.key}`)
      .join(', ') + (changes.length > 4 ? ` and ${changes.length - 4} more` : '');

  /** Run `work`; its reply, every row it changed anywhere, and every push it sent anyone. */
  const observed = async (work) => {
    const before = await snapshot();
    const mark = shape.runtime.sent.length;
    const reply = await work();
    await shape.settle();
    return { reply, changes: diff(before, await snapshot()), pushes: shape.runtime.since(mark) };
  };

  const owned = new Set();
  for (const t of tables) {
    const columns = await shape.rows(`SHOW COLUMNS FROM \`${t}\``);
    if (columns.some((col) => col.Field === 'citizenid')) owned.add(t);
  }

  /** The row `work` adds to `table` — `who`'s, where the table says whose a row is. */
  const newRowIn = async (table, who, work) => {
    const before = (await shape.rows(`SELECT COALESCE(MAX(id), 0) AS n FROM \`${table}\``))[0].n;
    const reply = await work();
    await shape.settle();
    const mine = who && owned.has(table) ? ' AND citizenid = ?' : '';
    const rows = await shape.rows(
      `SELECT id FROM \`${table}\` WHERE id > ?${mine} ORDER BY id`,
      mine ? [before, cid(who)] : [before]
    );
    if (rows.length === 0) {
      throw new Error(`producing a row in ${table} wrote none: ${JSON.stringify(reply)}`);
    }
    return rows.at(-1).id;
  };

  /* ---- what the server registered */
  const custom = new Set(b.registeredCustomActions());
  const declared = new Map(b.declaredServices.map((r) => [r.id, r]));
  const serviceOfTable = (table) => [...declared.values()].find((r) => r.table === table);
  const publicTables = new Set(
    [...declared.values()].filter((r) => r.access.read === 'public').map((r) => r.table)
  );
  const reactable = [...declared.values()].filter((r) => r.reactable).map((r) => r.table);
  /**
   * The rows a membership is of — a thread, a channel — from each `access.membership` declared:
   * the table its foreign key names. Such a row is answered for a member, not only its creator.
   */
  const memberTables = new Set(
    [...declared.values()]
      .filter((r) => r.membership)
      .map((r) => SLOT_TABLES[r.membership.foreignKey] ?? `(unmapped ${r.membership.foreignKey})`)
  );
  check(
    `${kind}: matrix — every declared membership names a table the matrix knows`,
    [...memberTables].filter((t) => t.startsWith('(')),
    []
  );
  const endpoint = [];
  const raw = [];
  for (const event of [...shape.runtime.netSafe].sort()) {
    if (!event.startsWith(PREFIX)) continue;
    const rest = event.slice(PREFIX.length);
    const split = rest.indexOf(':');
    const service = rest.slice(0, split);
    const action = rest.slice(split + 1);
    if (b.dispatcherFor(service, action)) {
      endpoint.push({
        service,
        action,
        key: rest,
        generic: GENERIC.has(action) && !custom.has(rest)
      });
    } else raw.push(event);
  }
  check(
    `${kind}: matrix — every raw handler is one that takes no row id`,
    raw,
    Object.keys(RAW_HANDLERS).sort()
  );

  /* ---- producers: a row of each table, earned through the shipped handlers */
  let serial = 0;
  /** The sender's marker: private, or public where the table is read by anyone. */
  const text = (who, table) =>
    `${publicTables.has(table) || table === 'mica_spark' ? P[who].pub : P[who].mark} ${++serial}`;

  /** What a column accepts that its declared rule alone would not build. */
  const CREATE_EXTRA = {
    media: () => ({ kind: 'photo', data: PNG }),
    contacts: () => ({ phone: `555${String(++serial).padStart(4, '0')}` })
  };

  const accounts = new Map();
  const accountOf = async (who, app) => {
    const k = `${who}:${app}`;
    if (!accounts.has(k)) {
      await call(who, 'accounts', 'create', {
        app,
        handle: `${P[who].pub}_${app}`,
        display_name: `${P[who].pub} ${app}`
      });
      const id = (await call(who, 'accounts', 'mine', { app }))?.rows?.[0]?.id;
      if (typeof id !== 'number') throw new Error(`no ${app} account for ${who}`);
      accounts.set(k, id);
    }
    return accounts.get(k);
  };
  /** Which app's account an action acts as. */
  const appOf = (c) =>
    c.appOfTarget ??
    (c.a.service === 'glimpse' || c.a.service === 'glimpse_comments' ? 'glimpse' : 'blabber');

  /** A generic `create`'s payload: the first client-writable column, and any required one. */
  const createData = (service, who) => {
    const r = declared.get(service);
    const data = {};
    for (const [i, column] of r.clientWritable.entries()) {
      const def = r.fields.find((f) => f.name === column)?.def ?? {};
      // The first column, so the row carries the creator's marker, and any the table requires.
      if (i > 0 && !(def.notNull && def.default === undefined)) continue;
      if (def.type === 'enum') data[column] = def.values[0];
      else if (['int', 'bigint', 'tinyint', 'float', 'decimal'].includes(def.type))
        data[column] = 1;
      else if (def.type === 'boolean') data[column] = true;
      else data[column] = text(who, r.table).slice(0, def.length ?? 64);
    }
    return { ...data, ...CREATE_EXTRA[service]?.(who) };
  };
  /** A generic `create`, its payload from the declaration. */
  const genericCreate = (service) => (who) =>
    newRowIn(declared.get(service).table, who, () =>
      call(who, service, 'create', createData(service, who))
    );

  /** The member a membership row is shared with, beside its creator. */
  const peerOf = (who) => (who === 'member' ? 'victim' : 'member');

  const PRODUCERS = {
    // A generic create, for any service that keeps one: a new service is produced with no edit.
    ...Object.fromEntries(
      endpoint
        .filter((a) => a.generic && a.action === 'create')
        .map((a) => [declared.get(a.service).table, genericCreate(a.service)])
    ),
    // The ones whose rule alone would be refused, by what the column accepts.
    mica_media: genericCreate('media'),
    mica_contacts: genericCreate('contacts'),
    mica_accounts: (who) => accountOf(who, 'blabber'),
    mica_places: (who) =>
      newRowIn('mica_places', who, () =>
        call(who, 'places', 'create', { name: text(who, 'mica_places') })
      ),
    mica_blabber: async (who) => {
      const account_id = await accountOf(who, 'blabber');
      return newRowIn('mica_blabber', who, () =>
        call(who, 'blabber', 'create', { account_id, body: text(who, 'mica_blabber') })
      );
    },
    mica_glimpse: async (who) => {
      const account_id = await accountOf(who, 'glimpse');
      const photo_id = await PRODUCERS.mica_media(who);
      return newRowIn('mica_glimpse', who, () =>
        call(who, 'glimpse', 'create', {
          account_id,
          caption: text(who, 'mica_glimpse'),
          attachments: [{ photo_id }]
        })
      );
    },
    mica_glimpse_comments: async (who) => {
      const account_id = await accountOf(who, 'glimpse');
      const post_id = await PRODUCERS.mica_glimpse(who);
      return newRowIn('mica_glimpse_comments', who, () =>
        call(who, 'glimpse_comments', 'create', {
          account_id,
          post_id,
          body: text(who, 'mica_glimpse_comments')
        })
      );
    },
    mica_marketplace: (who) =>
      newRowIn('mica_marketplace', who, () =>
        call(who, 'marketplace', 'create', {
          title: text(who, 'mica_marketplace'),
          price: 1,
          description: text(who, 'mica_marketplace')
        })
      ),
    mica_blabber_dms: async (who) => {
      const account_id = await accountOf(who, 'blabber');
      const peer_account_id = await accountOf(THIRD[who], 'blabber');
      return newRowIn('mica_blabber_dms', who, () =>
        call(who, 'dms', 'send', {
          app: 'blabber',
          account_id,
          peer_account_id,
          body: text(who, 'mica_blabber_dms')
        })
      );
    },
    // A group, so every one is a fresh thread (a 1:1 is found again, not made again), with a
    // text in it so a read has something of the creator's to answer with.
    mica_messages_conversations: async (who) => {
      const participants = [await phoneOf(peerOf(who)), await phoneOf(THIRD[peerOf(who)])];
      const id = await newRowIn('mica_messages_conversations', who, () =>
        call(who, 'conversations', 'create', {
          participants,
          is_group: true,
          name: text(who, 'mica_messages_conversations')
        })
      );
      await call(who, 'messages', 'send', {
        conversation_id: id,
        message: text(who, 'mica_messages')
      });
      return id;
    },
    mica_messages: async (who) => {
      const conversation_id = await PRODUCERS.mica_messages_conversations(who);
      return newRowIn('mica_messages', who, () =>
        call(who, 'messages', 'send', { conversation_id, message: text(who, 'mica_messages') })
      );
    },
    mica_darkchat: async (who) => {
      const id = await newRowIn('mica_darkchat', who, () =>
        call(who, 'darkchat', 'create', { name: text(who, 'mica_darkchat'), alias: P[who].mark })
      );
      const code = (await call(who, 'darkchat', 'code', { channel_id: id }))?.code;
      const peer = peerOf(who);
      const joined = await call(peer, 'darkchat', 'join', { code, alias: P[peer].mark });
      if (isFailure(joined)) throw new Error(`${peer} could not join: ${JSON.stringify(joined)}`);
      await call(who, 'darkchat_messages', 'send', {
        channel_id: id,
        body: text(who, 'mica_darkchat_messages')
      });
      return id;
    },
    mica_darkchat_messages: async (who) => {
      const channel_id = await PRODUCERS.mica_darkchat(who);
      return newRowIn('mica_darkchat_messages', who, () =>
        call(who, 'darkchat_messages', 'send', {
          channel_id,
          body: text(who, 'mica_darkchat_messages')
        })
      );
    },
    // Another resource bills the citizen, as `runInvoice` does.
    mica_invoices: async (who) => {
      const bill = await shape.runtime.callExport('fake_billing', 'SendInvoice', cid(who), {
        from: text(who, 'mica_invoices'),
        amount: 1,
        memo: text(who, 'mica_invoices'),
        payee: cid(peerOf(who))
      });
      await shape.settle();
      if (typeof bill?.value?.id !== 'number') {
        throw new Error(`no invoice for ${who}: ${JSON.stringify(bill)}`);
      }
      return bill.value.id;
    },
    // A qb script mails the citizen, as `runQbMail` does.
    mica_mail: (who) =>
      newRowIn('mica_mail', who, () =>
        shape.fire(P[who].src, 'qb-phone:server:sendNewMail', {
          sender: text(who, 'mica_mail'),
          subject: text(who, 'mica_mail'),
          message: text(who, 'mica_mail')
        })
      ),
    // An invoice's push is kept as a notification.
    mica_notifications: async (who) => {
      const before = (
        await shape.rows('SELECT COALESCE(MAX(id), 0) AS n FROM mica_notifications')
      )[0].n;
      await PRODUCERS.mica_invoices(who);
      await shape.settle();
      const rows = await shape.rows(
        'SELECT id FROM mica_notifications WHERE id > ? AND citizenid = ? ORDER BY id',
        [before, cid(who)]
      );
      if (rows.length === 0) throw new Error(`an invoice kept ${who} no notification`);
      return rows.at(-1).id;
    },
    // A call the citizen makes and ends, as `runCall` does.
    mica_phone_call_log: async (who) => {
      const peer = peerOf(who);
      return newRowIn('mica_phone_call_log', who, async () => {
        await shape.fire(P[who].src, 'mica:server:phone:start', await phoneOf(peer));
        await shape.fire(P[peer].src, 'mica:server:phone:answer');
        return shape.fire(P[who].src, 'mica:server:phone:end');
      });
    },
    mica_reports: async (who) => {
      const targetId = await PRODUCERS.mica_blabber(peerOf(who));
      return newRowIn('mica_reports', who, () =>
        call(who, 'reports', 'create', { targetTable: 'mica_blabber', targetId, category: 'spam' })
      );
    },
    mica_casino_rounds: async (who) => {
      const stake = (await call(who, 'casino', 'config'))?.crash?.bet_min ?? 100;
      return newRowIn('mica_casino_rounds', who, () =>
        call(who, 'casino', 'crashStart', { stake })
      );
    },
    mica_spark: async (who) => {
      const [existing] = await shape.rows(
        "SELECT id FROM mica_spark WHERE citizenid = ? AND status = 'active'",
        [cid(who)]
      );
      if (existing) return existing.id;
      const photo_id = await PRODUCERS.mica_media(who);
      return newRowIn('mica_spark', who, () =>
        call(who, 'spark', 'save', {
          display_name: P[who].pub,
          age: 30,
          bio: text(who, 'mica_spark'),
          photos: [{ photo_id }]
        })
      );
    },
    mica_spark_matches: async (who) => {
      const peer = peerOf(who);
      const mine = await PRODUCERS.mica_spark(who);
      const theirs = await PRODUCERS.mica_spark(peer);
      return newRowIn('mica_spark_matches', who, async () => {
        await call(who, 'spark', 'swipe', { profile_id: theirs, verdict: 'like' });
        return call(peer, 'spark', 'swipe', { profile_id: mine, verdict: 'like' });
      });
    }
  };

  /** What a case's `state` does to the creator's row first. */
  const STATES = {
    deleted: (table, who, id) => call(who, serviceOfTable(table).id, 'delete', { id }),
    cleared: (table, who, id) => call(who, 'notifications', 'clearNotifications', { ids: [id] }),
    resolved: (table, who, id) => call('admin', 'reports', 'resolve', { id, action: 'dismiss' })
  };

  /** Rows the victim made for a case to name: anything but a line thread, made here. */
  const controlRows = new Map();
  const CONTROL_ROWS = {
    lineThread: async () => {
      if (controlRows.has('lineThread')) return controlRows.get('lineThread');
      const id = await newRowIn('mica_messages_conversations', 'victim', () =>
        call('victim', 'conversations', 'create', { phone: LINE })
      );
      await call('victim', 'messages', 'send', {
        conversation_id: id,
        message: text('victim', 'mica_messages')
      });
      controlRows.set('lineThread', id);
      return id;
    }
  };

  /* ---- the cases */
  // A job line of the matrix's own beside whatever the flows registered, put back afterwards.
  const linesBefore = globalThis.GetConvar('mica_job_lines', '');
  if (kind === 'qb') {
    shape.runtime.setConvar(
      'mica_job_lines',
      JSON.stringify([
        ...JSON.parse(linesBefore || '[]'),
        { number: LINE, label: 'Matrix Line', jobs: ['police'] }
      ])
    );
    // A call to a number nobody answers for re-reads the lines (`refreshJobLines`), so the
    // victim rings it once and hangs up: the shipped way a new line is picked up.
    await shape.fire(P.victim.src, 'mica:server:phone:start', LINE);
    await shape.fire(P.victim.src, 'mica:server:phone:end');
  }

  const cases = [];
  /** Inputs the matrix cannot see a row id in, where one may be: each fails the run. */
  const opaque = [];
  let unionsSeen = 0;
  /** Whether a schema holds an id-named field anywhere, or cannot be seen into at all. */
  const hidesAnId = (schema, path = []) => {
    const here = b.shapeOf(schema);
    if (!here) return true;
    if (here.kind === 'object') {
      return Object.entries(here.shape).some(
        ([k, v]) => isIdPath([...path, k]) || hidesAnId(v, [...path, k])
      );
    }
    if (here.kind === 'array') return isIdPath([...path, 0]) || hidesAnId(here.item, [...path, 0]);
    if (here.kind === 'union') return here.members.some((m) => hidesAnId(m, path));
    if (here.kind === 'tuple') return here.elements.some((m, i) => hidesAnId(m, [...path, i]));
    return false;
  };
  for (const a of endpoint) {
    if (a.generic) {
      const r = declared.get(a.service);
      if (a.action === 'update' || a.action === 'delete') {
        cases.push({ a, path: ['id'], table: r.table, generic: true });
      } else if (a.action === 'get') {
        cases.push({ a, path: [], table: r.table, generic: true, list: true });
      }
      // A client-writable column that names a row is a row id the payload chooses, on a create
      // or an update alike: one case each, the table by the column's name.
      if (a.action === 'create' || a.action === 'update') {
        for (const column of r.clientWritable.filter((col) => isIdPath([col]))) {
          cases.push({ a, path: [column], table: SLOT_TABLES[column], generic: true, column });
        }
      }
      continue;
    }
    const input = b.contractFor(a.service)?.actions[a.action]?.input;
    const d = b.shapeOf(input);
    // One set of cases per reactable table, where the action names which one.
    const variants =
      d?.kind === 'object' && 'target_table' in d.shape && a.service === 'accounts'
        ? reactable.map((table) => ({
            targetTable: table,
            appOfTarget: table === 'mica_glimpse' ? 'glimpse' : 'blabber',
            emoji: serviceOfTable(table)?.reactable?.emoji?.[0]
          }))
        : [{}];
    if (!d) opaque.push(`${a.key}: its input has no recorded shape`);
    const walk = (schema, path, variant) => {
      const shapeHere = b.shapeOf(schema);
      if (!shapeHere) return;
      if (shapeHere.kind === 'union' || shapeHere.kind === 'tuple') {
        // Not varied member by member: a payload is synthesized from the first member that
        // builds, so a row id in any other would never be sent. Loud instead, where one hides.
        unionsSeen += 1;
        const members = shapeHere.kind === 'union' ? shapeHere.members : shapeHere.elements;
        if (members.some((member) => hidesAnId(member))) {
          opaque.push(
            `${a.key}.${pathLabel(path) || '(input)'}: a ${shapeHere.kind} with a row id inside`
          );
        }
        return;
      }
      if (shapeHere.kind === 'object') {
        for (const [k, v] of Object.entries(shapeHere.shape)) {
          const p = [...path, k];
          if (isIdPath(p)) cases.push({ a, path: p, input, ...variant });
          walk(v, p, variant);
        }
      } else if (shapeHere.kind === 'array') {
        const p = [...path, 0];
        if (isIdPath(p)) cases.push({ a, path: p, input, ...variant });
        walk(shapeHere.item, p, variant);
      }
    };
    for (const variant of variants) walk(input, [], variant);
  }

  const unmapped = [];
  for (const c of cases) {
    c.label = c.list ? c.a.key : `${c.a.key}.${pathLabel(c.path)}`;
    c.name = c.targetTable ? `${c.label}@${c.targetTable}` : c.label;
    c.spec = {
      ...CASES[`${c.a.service}:*`],
      ...CASES[`${c.a.key}.*`],
      ...CASES[c.label],
      ...CASES[c.name],
      ...CASES[`${c.label}@${kind}`]
    };
    if (c.generic) {
      if (c.column && !c.table && !c.spec.undrivable) unmapped.push(c.name);
      continue;
    }
    const name = fieldName(c.path);
    c.table =
      c.spec.table ??
      (c.targetTable && /^target_ids?$/.test(name) ? c.targetTable : undefined) ??
      (name === 'id' || name === 'ids' ? declared.get(c.a.service)?.table : SLOT_TABLES[name]);
    if (c.targetTable && /^target_ids?$/.test(name) && publicTables.has(c.targetTable)) {
      // Reacting to a public row, or reading its reactions, is the feature; a private one's
      // (a DM) is its two ends' alone, which is what the other variant holds it to.
      c.spec.byDesign ??= "a public row's reactions are anybody's to add and read";
    }
    if (!c.table && !c.spec.undrivable) unmapped.push(c.name);
  }
  check(`${kind}: matrix — every id field names a table or is pinned`, unmapped, []);
  check(`${kind}: matrix — every input is one the matrix can see a row id in`, opaque, []);

  /** The payload `who` sends for a case: the row under test, and `who`'s own rows elsewhere. */
  const payloadFor = async (c, who, rowId) => {
    if (c.generic && c.column) {
      // The sender's own row (a new one, or one they update), naming the case's row.
      const r = declared.get(c.a.service);
      if (c.a.action === 'create') return { ...createData(c.a.service, who), [c.column]: rowId };
      return { id: await PRODUCERS[r.table](who), [c.column]: rowId };
    }
    if (c.generic) {
      if (c.list) return {};
      if (c.a.action === 'delete') return { id: rowId };
      const r = declared.get(c.a.service);
      const column = r.clientWritable[0];
      const def = r.fields.find((f) => f.name === column)?.def ?? {};
      const value = def.type === 'enum' ? def.values.at(-1) : `${text(who, r.table)} edit`;
      return { id: rowId, [column]: value };
    }
    const built = b.synthesize(c.input);
    if (!built.ok) throw new Error(`no payload (${built.why})`);
    let payload = built.value;
    for (const name of Object.keys(b.shapeOf(c.input).shape)) {
      const fill = FIELD_VALUES[`${c.a.key}.${name}`] ?? FIELD_VALUES[`${c.a.service}:*.${name}`];
      if (fill) payload = { ...payload, [name]: fill(who, c, text) };
    }
    if (c.targetTable) payload = { ...payload, target_table: c.targetTable };
    for (const other of cases) {
      if (other.a !== c.a || other === c || other.targetTable !== c.targetTable) continue;
      if (!(other.path[0] in payload) || !other.table || other.spec.undrivable) continue;
      // A field that names somebody else on purpose names a third party; any other, `who`'s own.
      const owner = other.spec.byDesign ? THIRD[who] : who;
      const own =
        other.table === 'mica_accounts'
          ? await accountOf(owner, appOf(c))
          : await PRODUCERS[other.table]?.(owner);
      if (own !== undefined) payload = setAt(payload, other.path, own);
    }
    for (const field of c.spec.same ?? []) payload = setAt(payload, [field], rowId);
    if (c.spec.parent && who !== 'attacker') {
      const [field, table, column] = c.spec.parent;
      const [row] = await shape.rows(`SELECT \`${column}\` AS v FROM \`${table}\` WHERE id = ?`, [
        rowId
      ]);
      payload = { ...payload, [field]: row.v };
    }
    return setAt(payload, c.path, rowId);
  };

  const counts = {
    cases: cases.length,
    refused: 0,
    stripped: 0,
    silent: 0,
    byDesign: 0,
    controls: 0,
    memberControls: 0,
    undrivable: 0
  };
  const undriven = [];
  const failures = [];
  const silentCases = [];
  const strippedCases = [];
  const memberServices = new Set();

  /**
   * Whether a row names this id in a column other than its own `id`. Compared as text: a
   * `bigint` can come back from the driver as a string, and a strict `===` would then miss it
   * and read a row naming the victim's as one that does not.
   */
  const namesId = (row, id) =>
    Object.entries(row ?? {}).some(
      ([column, value]) => column !== 'id' && value !== null && String(value) === String(id)
    );
  /** Whether a change is to this row, or to a row that names it. */
  const touches = (changes, id) =>
    changes.some((ch) => ch.key === String(id) || namesId(ch.now ?? ch.row, id));
  /** Which clause answered each control, so the weak ones are counted and named. */
  const evidence = {};
  /** Which clause showed each by-design attack was really answered. */
  const designEvidence = {};
  const weak = [];
  /** Attacks refused by a throw the action did not mean (`server.generic`). */
  const crashed = [];

  // A case that leaves something standing nobody can undo (a Spark block) goes last.
  cases.sort((x, y) => Number(Boolean(x.spec.last)) - Number(Boolean(y.spec.last)));

  /**
   * What of the victim's must never reach the attacker, in a reply or a push: the private
   * marker in every non-public row they wrote, their citizenid and license (MICA-339: an
   * identity no public projection carries), and the value of every `private` text column on a
   * public table that holds one for them. Those columns are written by the server, not the
   * client, so their marker is the value the server wrote — `seller_phone` is the victim's
   * number. A case that hands one out on purpose names it in `discloses`, with why.
   */
  const privateColumns = [...declared.values()]
    .filter((r) => r.access.read === 'public')
    .flatMap((r) =>
      r.fields
        .filter(
          (f) =>
            f.def.private &&
            !f.def.generatedAs &&
            ['string', 'text', 'mediumtext'].includes(f.def.type)
        )
        .map((f) => ({ table: r.table, column: f.name }))
    );
  const secretsOf = async (c) => {
    const out = [
      { label: 'private marker', value: P.victim.mark },
      { label: 'citizenid', value: cid('victim') },
      { label: 'license', value: P.victim.license }
    ];
    for (const { table, column } of privateColumns) {
      if (c.spec.discloses?.includes(column)) continue;
      const held = await shape.rows(
        `SELECT DISTINCT \`${column}\` AS v FROM \`${table}\` WHERE citizenid = ? AND \`${column}\` IS NOT NULL`,
        [cid('victim')]
      );
      for (const { v } of held) {
        if (String(v).length >= 5) out.push({ label: `${table}.${column}`, value: String(v) });
      }
    }
    return out;
  };
  const leakIn = (json, secrets) => secrets.find((secret) => json.includes(secret.value))?.label;
  /** What the attacker was pushed, as the attacker's phone would see it, and what the victim was. */
  const pushedTo = (pushes, src) =>
    JSON.stringify(
      pushes.filter((m) => m.target === src || m.target === -1).map((m) => [m.event, m.args])
    );

  step(`${kind}: matrix — ${cases.length} cases, each attacked and then controlled`);
  try {
    for (const c of cases) {
      const shapes = c.spec.shapes;
      if (c.spec.undrivable && (!shapes || shapes.includes(kind))) {
        undriven.push(c.name);
        counts.undrivable += 1;
        continue;
      }
      if (!PRODUCERS[c.table]) {
        failures.push(`${c.name}: nothing produces a row of ${c.table}`);
        continue;
      }
      const r = declared.get(c.a.service);
      const byDesign = (c.list && r?.access.read === 'public') || c.spec.byDesign;
      const controlWho =
        c.spec.controlBy ?? (memberTables.has(c.table) && !c.list ? 'member' : 'victim');
      const ctx = { call, accountOf, phoneOf, produce: (table, who) => PRODUCERS[table](who) };
      try {
        if (c.spec.needs) {
          for (const who of ['attacker', controlWho]) await PRODUCERS[c.spec.needs](who);
        }
        const rowId = c.spec.row
          ? await c.spec.row(ctx)
          : c.table === 'mica_accounts'
            ? await accountOf('victim', appOf(c))
            : await PRODUCERS[c.table]('victim');
        ctx.rowId = rowId;
        if (c.spec.state) {
          const done = await STATES[c.spec.state](c.table, 'victim', rowId);
          if (isFailure(done)) {
            throw new Error(`could not make the row ${c.spec.state}: ${JSON.stringify(done)}`);
          }
        }
        const filled = async (payload) =>
          c.spec.complete ? c.spec.complete(ctx, payload) : payload;
        const attackPayload = await filled(await payloadFor(c, 'attacker', rowId));
        const controlRowId = c.spec.controlRow ? await CONTROL_ROWS[c.spec.controlRow]() : rowId;
        const controlPayload = byDesign
          ? null
          : await filled(await payloadFor(c, controlWho, controlRowId));
        if (c.spec.before) await c.spec.before(ctx);
        if (c.spec.prepare) {
          // By design, the attacker undoes something of their own, so they do it first.
          const [service, action] = c.spec.prepare;
          const ready = byDesign
            ? await call('attacker', service, action, attackPayload)
            : await call(controlWho, service, action, controlPayload);
          if (isFailure(ready)) {
            throw new Error(`the ${action} first was refused: ${JSON.stringify(ready)}`);
          }
        }

        const attack = await observed(() =>
          call('attacker', c.a.service, c.a.action, attackPayload)
        );
        if (PRE_VALIDATION_KEYS.has(attack.reply?.key)) {
          failures.push(`${c.name}: the attack never reached the action (${attack.reply.key})`);
          continue;
        }
        const said = JSON.stringify(attack.reply ?? null);
        const secrets = await secretsOf(c);
        const toAttacker = pushedTo(attack.pushes, P.attacker.src);
        const pushLeak = leakIn(toAttacker, secrets);
        const undo = async (who, payload) => {
          if (!c.spec.undo) return;
          const [service, action] = c.spec.undo;
          await call(who, service, action, payload);
        };
        if (byDesign) {
          // A column the action is the other end's to set (a DM's `read_at`, set by whoever it
          // was sent to) may move on a row the victim owns; nothing else may.
          const moved = (ch) =>
            Object.keys(ch.row).filter(
              (k) => JSON.stringify(ch.row[k]) !== JSON.stringify(ch.now[k])
            );
          const lost = attack.changes.filter(
            (ch) =>
              ch.change !== 'added' &&
              ch.row?.citizenid === cid('victim') &&
              !(
                ch.change === 'changed' &&
                moved(ch).some((k) => c.spec.mayChange?.includes(`${ch.table}.${k}`)) &&
                // `updated_at` moves with it only when the second turns over between the two.
                moved(ch).every(
                  (k) => k === 'updated_at' || c.spec.mayChange?.includes(`${ch.table}.${k}`)
                )
              )
          );
          const refused = attack.reply?.error !== undefined || attack.reply?.ok === false;
          await undo('attacker', attackPayload);
          if (c.spec.after) await c.spec.after(ctx);
          // Public by design is the row the field names, never what else the victim holds.
          const leakedPrivate = leakIn(said, secrets);
          // And answered for real: the attack wrote what names the row, or answered with it.
          const [real] =
            [
              ['wrote what names the row', touches(attack.changes, rowId)],
              ["answered with the victim's public marker", said.includes(P.victim.pub)],
              ['answered with the row', namesRow(said, rowId) || said.includes(`"${rowId}":`)],
              ['answered by its pin', c.spec.answer?.(attack) === true],
              ['answered something', answersSomething(attack.reply)]
            ].find(([, held]) => held) ?? [];
          if (real) designEvidence[real] = [...(designEvidence[real] ?? []), c.name];
          if (refused || lost.length > 0 || leakedPrivate || pushLeak || !real) {
            failures.push(
              `${c.name}: by design, but ` +
                (lost.length
                  ? `the victim's rows changed: ${describe(lost)}`
                  : leakedPrivate
                    ? `the reply carries the victim's ${leakedPrivate}: ${said.slice(0, 160)}`
                    : pushLeak
                      ? `a push to the attacker carries the victim's ${pushLeak}`
                      : refused
                        ? `refused: ${said.slice(0, 160)}`
                        : `nothing shows it was answered: ${said.slice(0, 160)}`)
            );
            continue;
          }
          counts.byDesign += 1;
          continue;
        }
        /**
         * Refused means nothing of anybody else's changed. An action that writes the caller's own
         * rows (a post with an attachment, the thread a text lands in) may still write them, and
         * those are the only rows it may touch: the attacker's before and after, and naming the
         * victim's row nowhere. That is a refusal by stripping the stolen id, counted apart.
         */
        const attackers = (row) => row === undefined || row.citizenid === cid('attacker');
        const names = (row) => namesId(row, rowId);
        const ownAdditions = attack.changes.filter(
          (ch) =>
            (ch.change === 'added' || ch.change === 'changed') &&
            attackers(ch.row) &&
            attackers(ch.now) &&
            !names(ch.row) &&
            !names(ch.now)
        );
        const foreign = attack.changes.filter((ch) => !ownAdditions.includes(ch));
        // Counted by what it added: a timestamp on the attacker's own row moves only when the
        // second turns over, so a change alone would make the count depend on the clock.
        const stripped = ownAdditions.some((ch) => ch.change === 'added');
        const leaked =
          leakIn(said, secrets) ?? (c.list && namesRow(said, rowId) ? 'row' : undefined);
        // A refused action pushes the victim nothing: a push is a write to their phone.
        const toVictim = attack.pushes.filter(
          (m) => m.target === P.victim.src && !(m.event in AMBIENT_PUSHES)
        );
        if (foreign.length > 0 || leaked || pushLeak || toVictim.length > 0) {
          await undo('attacker', attackPayload);
          if (c.spec.after) await c.spec.after(ctx);
          failures.push(
            `${c.name}: NOT REFUSED —` +
              (leaked ? ` the reply carries the victim's ${leaked}` : '') +
              (pushLeak ? ` a push to the attacker carries the victim's ${pushLeak}` : '') +
              (toVictim.length ? ` the victim was pushed ${toVictim.map((m) => m.event)}` : '') +
              (foreign.length ? ` it changed ${describe(foreign)}` : '') +
              ` (reply ${said.slice(0, 200)})`
          );
          continue;
        }

        // The positive control: the same action and shape, from somebody it is meant to answer.
        const control = await observed(() =>
          call(controlWho, c.a.service, c.a.action, controlPayload)
        );
        await undo(controlWho, controlPayload);
        if (c.spec.after) await c.spec.after(ctx);
        const shown = JSON.stringify(control.reply ?? null);
        if (
          !isFailure(attack.reply) &&
          !stripped &&
          said === shown &&
          !touches(control.changes, controlRowId)
        ) {
          failures.push(
            `${c.name}: NOT REFUSED — the attacker was answered exactly as ${controlWho} was: ` +
              said.slice(0, 200)
          );
          continue;
        }
        // Where the attack wrote the attacker's own row, the owner's must have used the id. The
        // first clause that holds is kept, strongest first, so the weak ones can be counted.
        const clauses = [
          ['touches the row', touches(control.changes, controlRowId)],
          ['answers the marker', shown.includes(P.victim.mark) || shown.includes(P.victim.pub)],
          ['answers the row', namesRow(shown, controlRowId)],
          [
            'answered where the attack was refused',
            isFailure(attack.reply) && !isFailure(control.reply)
          ],
          ['answered differently', !isFailure(control.reply) && shown !== said],
          ['accepted by its pin', c.spec.accepts?.(control.reply) === true]
        ];
        const [answeredBy] =
          (stripped ? clauses.slice(0, 1) : clauses).find(([, held]) => held) ?? [];
        if (!answeredBy || (isFailure(control.reply) && !c.spec.accepts?.(control.reply))) {
          failures.push(
            `${c.name}: the control (${controlWho}) was not answered, so the refusal proves ` +
              `nothing: ${shown.slice(0, 200)} (the attack: ${said.slice(0, 120)})`
          );
          continue;
        }
        evidence[answeredBy] = (evidence[answeredBy] ?? 0) + 1;
        if (clauses.findIndex(([label]) => label === answeredBy) >= 3) {
          weak.push(`${c.name} (${answeredBy})`);
        }
        if (attack.reply?.key === 'server.generic') crashed.push(c.name);
        counts.refused += 1;
        if (stripped) {
          counts.stripped += 1;
          strippedCases.push(
            `${c.name} [added ${ownAdditions.filter((ch) => ch.change === 'added').map((ch) => ch.table)}]`
          );
        } else if (!isFailure(attack.reply)) {
          counts.silent += 1;
          silentCases.push(c.name);
        }
        counts.controls += 1;
        if (controlWho === 'member') {
          counts.memberControls += 1;
          memberServices.add(c.a.service);
        }
      } catch (error) {
        failures.push(`${c.name}: ${error.message}`);
      }
    }
  } finally {
    // Put back whatever the flows had, however the loop ended.
    if (kind === 'qb') shape.runtime.setConvar('mica_job_lines', linesBefore || undefined);
  }

  for (const f of failures) console.log(`    FAIL ${f}`);
  console.log(`    ${kind} matrix counts: ${JSON.stringify(counts)}`);
  console.log(
    `    refused by an answer that changed and showed nothing: ${silentCases.join(', ')}`
  );
  console.log(
    `    refused by writing the attacker's own row without the id: ${strippedCases.join(', ')}`
  );
  console.log(`    controls answered by: ${JSON.stringify(evidence)}`);
  for (const [clause, names] of Object.entries(designEvidence)) {
    console.log(
      `    by design, ${clause}: ${names.length}${clause === 'answered something' ? ` (${names.join(', ')})` : ''}`
    );
  }
  console.log(`    unions and tuples walked, none hiding a row id: ${unionsSeen}`);
  console.log(`    controls on a weak clause: ${weak.join(', ')}`);
  console.log(`    attacks refused by a throw (server.generic): ${crashed.join(', ') || 'none'}`);
  check(`${kind}: matrix — no case failed`, failures, []);
  check(
    `${kind}: matrix — the undrivable cases are exactly the pinned ones`,
    undriven.sort(),
    Object.entries(CASES)
      .filter(
        ([k, v]) =>
          v.undrivable &&
          !k.endsWith('@qb') &&
          !(k.endsWith('@standalone') && kind !== 'standalone')
      )
      .filter(([, v]) => !v.shapes || v.shapes.includes(kind))
      .map(([k]) => k.replace(/@(standalone|qb)$/, ''))
      .sort()
  );
  // Both ways, per declared membership: a member answered, an outsider refused, on every
  // service whose declaration names one.
  check(
    `${kind}: matrix — every membership service has a member answered and an outsider refused`,
    [...declared.values()]
      .filter((r) => r.membership && !memberServices.has(r.id))
      .map((r) => r.id),
    []
  );
  check(`${kind}: matrix — the counts`, counts, MATRIX_COUNTS[kind]);
};
