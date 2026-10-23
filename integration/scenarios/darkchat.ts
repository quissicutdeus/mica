// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { call, invoke, pushes, seedPlayer, waitForPush, type PushEnvelope } from '../lib/door';
import { assert, harnessKeys, seedCitizen, unique } from '../lib/mica';
import { openSealed } from '../lib/sealed';
import { schemaCreated } from './qbx';

/**
 * Dark Chat (MICA-254, `server/services/Darkchat.ts` and `DarkchatMessages.ts`) inside a real
 * FXServer on a real MariaDB, driven through the integration door (MICA-397, `../lib/door.ts`):
 * every action runs its own dispatch — limiter, app switch, contract parse, `requirePhoneFor`,
 * handler — as a synthetic player. Standalone only: `send` is a `requirePhoneFor` action, and
 * the door's players hold no phone item, which only the standalone run does not ask for.
 *
 * "Anonymous" is to the other members, not to staff (dc93dfae): nothing a member is answered or
 * pushed carries a citizenid, a phone number or a member row's integer id — a member is known
 * by an alias and a random sixteen-symbol handle — while the tables keep the real author, and a
 * report names the reporter by alias (`reporter_label`) beside the reported author.
 *
 * Every scenario asserts against the reply and the table, and cleans up every row its citizens
 * reached in `finally`. No draw here is random in a way a scenario depends on, so none has two
 * honest paths to print.
 */

const CHANNELS = 'darkchat';
const MESSAGES = 'darkchat_messages';

/** `Darkchat.ts`'s alphabet, restated: no `0`/`O`, no `1`/`I`/`L`. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = new RegExp(`^[${ALPHABET}]{8}$`);
const HANDLE = new RegExp(`^[${ALPHABET}]{16}$`);

/** The refusals the handlers raise, as `ServiceEndpoint` answers a `PlayerFacingError`. */
const BAD_CODE = { error: 'That code did not work.', key: 'server.darkchat.badCode' };
const NOT_MEMBER = { error: 'You are not in that channel.', key: 'server.darkchat.notMember' };
const NOT_OWNER = {
  error: 'Only the channel owner can do that.',
  key: 'server.darkchat.notOwner'
};

/** Generous for a push sent after a write the reply already confirmed; polled every 200 ms. */
const PUSH_WAIT_MS = 5_000;

/** Every scenario here is a few dozen door calls; this only bounds a hang. */
const SCENARIO_MS = 20_000;

/** The wire shapes, as `shared/types.ts` declares them. Restated, not imported. */
interface Channel {
  id: number;
  name: string;
  my_member_id: string;
  my_alias: string;
  is_owner: boolean;
}
interface Joined {
  channel: Channel;
  code?: string | null;
}
interface Member {
  id: string;
  alias: string;
}
interface Message {
  id: number;
  channel_id: number;
  member_id: string | null;
  alias: string;
  bot: boolean;
  mine: boolean;
  body: string;
  created_at: unknown;
}
/** What the door's capture holds, with the two envelope fields `PushEnvelope` leaves out. */
type Envelope = PushEnvelope & {
  notify?: { type?: string; title?: string; message?: string } | null;
  persisted?: boolean;
};

const CHANNEL_KEYS = 'id,is_owner,my_alias,my_member_id,name';
const MEMBER_KEYS = 'alias,id';
const MESSAGE_KEYS = 'alias,body,bot,channel_id,created_at,id,member_id,mine';

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const keysOf = (value: unknown): string =>
  value && typeof value === 'object' ? Object.keys(value).sort().join(',') : `(${show(value)})`;

const isChannel = (value: unknown): value is Channel => {
  const c = value as Channel | null;
  return (
    typeof c?.id === 'number' &&
    typeof c.name === 'string' &&
    typeof c.my_member_id === 'string' &&
    typeof c.my_alias === 'string' &&
    typeof c.is_owner === 'boolean'
  );
};

/**
 * A refusal exactly as the handler raised it: its message and catalog key, and nothing beside
 * them but `params`, which a `PlayerFacingError` without any leaves empty.
 */
const assertRefused = (
  reply: unknown,
  expected: { error: string; key: string },
  what: string
): void => {
  const got = reply as { error?: unknown; key?: unknown; params?: unknown } | null;
  assert(
    got !== null &&
      typeof got === 'object' &&
      got.error === expected.error &&
      got.key === expected.key,
    `${what}: expected the refusal ${show(expected)}, got ${show(reply)}`
  );
  const extra = Object.keys(got as object).filter((k) => !['error', 'key', 'params'].includes(k));
  assert(extra.length === 0, `${what}: the refusal carries more than its message: ${show(reply)}`);
  assert(got?.params == null, `${what}: the refusal carries params ${show(got?.params)}`);
};

// ─── actions ─────────────────────────────────────────────────────────────────────────────────

const create = async (who: string, name: string, alias: string): Promise<Joined> => {
  const { result } = await call<Joined>(CHANNELS, 'create', who, { name, alias });
  assert(
    isChannel(result?.channel) &&
      result.channel.is_owner === true &&
      typeof result.code === 'string' &&
      CODE.test(result.code),
    `create as '${alias}' answered ${show(result)}; expected an owned channel and an 8-symbol code`
  );
  return result;
};

const join = async (who: string, code: string, alias: string): Promise<Joined> => {
  const { result } = await call<Joined>(CHANNELS, 'join', who, { code, alias });
  assert(
    isChannel(result?.channel),
    `join as '${alias}' with '${code}' answered ${show(result)}; expected a channel`
  );
  return result;
};

const channelsOf = async (who: string): Promise<Channel[]> => {
  const { result } = await call<Channel[]>(CHANNELS, 'list', who, {});
  assert(Array.isArray(result), `darkchat:list answered ${show(result)}; expected an array`);
  return result;
};

const membersOf = async (who: string, channelId: number): Promise<Member[]> => {
  const { result } = await call<Member[]>(CHANNELS, 'members', who, { channel_id: channelId });
  assert(Array.isArray(result), `darkchat:members answered ${show(result)}; expected an array`);
  return result;
};

const leave = async (who: string, channelId: number): Promise<unknown> =>
  (await call<boolean>(CHANNELS, 'leave', who, { channel_id: channelId })).result;

const send = async (who: string, channelId: number, body: string): Promise<Message> => {
  const { result } = await call<Message>(MESSAGES, 'send', who, { channel_id: channelId, body });
  assert(
    typeof result?.id === 'number' && result.id > 0,
    `darkchat_messages:send answered ${show(result)}; expected the message with its id`
  );
  return result;
};

const read = async (who: string, channelId: number): Promise<Message[]> => {
  const { result } = await call<{ rows?: Message[] }>(MESSAGES, 'list', who, {
    channel_id: channelId
  });
  assert(
    Array.isArray(result?.rows),
    `darkchat_messages:list answered ${show(result)}; expected a page of rows`
  );
  return result.rows as Message[];
};

const isMessagePush =
  (messageId: number) =>
  (envelope: PushEnvelope): boolean =>
    envelope.app === 'darkchat' &&
    envelope.event === 'message' &&
    Number((envelope.payload?.message as { id?: unknown } | undefined)?.id) === messageId;

// ─── the tables ──────────────────────────────────────────────────────────────────────────────

interface MemberRow {
  id: number;
  handle: string;
  alias: string;
  status: string;
  live: boolean;
}

/** One citizen's member rows in one channel, oldest first. `left_at` read as a flag, not a date. */
const memberRows = async (channelId: number, citizenid: string): Promise<MemberRow[]> => {
  const rows = await db.rows(
    'SELECT `id`, `citizenid`, `channel_id`, `handle`, `alias`, `status`, ' +
      '(`left_at` IS NULL) AS live ' +
      'FROM `mica_darkchat_members` WHERE `channel_id` = ? AND `citizenid` = ? ORDER BY `id`',
    [channelId, citizenid]
  );
  // The alias and handle are sealed to the member and the channel (MICA-432): opened with the
  // key the harness wrote.
  const keys = harnessKeys();
  const open = (row: Record<string, unknown>, column: 'alias' | 'handle'): string =>
    openSealed(row[column], keys, {
      table: 'mica_darkchat_members',
      column,
      citizenid: String(row.citizenid),
      scope: [Number(row.channel_id)]
    });
  return rows.map((row) => ({
    id: Number(row.id),
    handle: open(row, 'handle'),
    alias: open(row, 'alias'),
    status: String(row.status),
    live: Number(row.live) === 1
  }));
};

const channelRow = async (
  id: number
): Promise<{ citizenid: string; name: string; code: string; status: string } | null> => {
  const row = await db.row(
    'SELECT `citizenid`, `seal_key`, `name`, `code`, `status` FROM `mica_darkchat` WHERE `id` = ?',
    [id]
  );
  if (!row) return null;
  // The name and code are sealed to the channel (`seal_key`, MICA-432), not to its owner.
  const open = (column: 'name' | 'code'): string =>
    openSealed(row[column], harnessKeys(), {
      table: 'mica_darkchat',
      column,
      citizenid: String(row.citizenid),
      sealKey: String(row.seal_key),
      scope: []
    });
  return {
    citizenid: String(row.citizenid),
    name: open('name'),
    code: open('code'),
    status: String(row.status)
  };
};

/** A well-formed code no channel holds, so a refusal of it is the code's and not its shape's. */
const unusedCode = async (): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let code = '';
    for (let i = 0; i < 8; i += 1) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    // Every channel's code, opened (MICA-432): the code is sealed, so SQL cannot compare it.
    const rows = await db.rows('SELECT `citizenid`, `seal_key`, `code` FROM `mica_darkchat`');
    const taken = rows.some(
      (row) =>
        openSealed(row.code, harnessKeys(), {
          table: 'mica_darkchat',
          column: 'code',
          citizenid: String(row.citizenid),
          sealKey: String(row.seal_key),
          scope: []
        }) === code
    );
    if (!taken) return code;
  }
  throw new Error('could not draw a code no channel holds in five tries');
};

/**
 * Every Dark Chat row these citizens reached, children before parents: the reports they filed,
 * then every message, member and channel row of any channel they owned or joined, and any phone
 * number a fixture gave them.
 */
const forget = async (citizenids: readonly string[]): Promise<void> => {
  const marks = citizenids.map(() => '?').join(', ');
  const ids = new Set<number>();
  for (const row of await db.rows(
    `SELECT \`id\` FROM \`mica_darkchat\` WHERE \`citizenid\` IN (${marks})`,
    [...citizenids]
  )) {
    ids.add(Number(row.id));
  }
  for (const row of await db.rows(
    `SELECT DISTINCT \`channel_id\` FROM \`mica_darkchat_members\` WHERE \`citizenid\` IN (${marks})`,
    [...citizenids]
  )) {
    ids.add(Number(row.channel_id));
  }
  await db.exec(`DELETE FROM \`mica_reports\` WHERE \`citizenid\` IN (${marks})`, [...citizenids]);
  await db.exec(`DELETE FROM \`mica_phone_numbers\` WHERE \`citizenid\` IN (${marks})`, [
    ...citizenids
  ]);
  const channels = [...ids].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (channels.length === 0) return;
  const at = channels.map(() => '?').join(', ');
  await db.exec(`DELETE FROM \`mica_darkchat_messages\` WHERE \`channel_id\` IN (${at})`, channels);
  await db.exec(`DELETE FROM \`mica_darkchat_members\` WHERE \`channel_id\` IN (${at})`, channels);
  await db.exec(`DELETE FROM \`mica_darkchat\` WHERE \`id\` IN (${at})`, channels);
};

// ─── scenarios ───────────────────────────────────────────────────────────────────────────────

export const darkchatScenarios: readonly Scenario[] = [
  {
    // MICA-254: a channel is created with a code, a second citizen joins by that code typed as
    // it is read aloud (lower case, a dash), posts under their alias, and both members read the
    // post — the poster as `mine`, the owner not. The rows are what the replies said: the owner
    // on the channel, the poster on the message through their member row, the body sealed.
    id: 'darkchat-join-by-code-post-and-both-read',
    mode: 'standalone',
    tickets: ['MICA-254', 'MICA-397'],
    timeoutMs: SCENARIO_MS,
    run: async (signal) => {
      await schemaCreated(signal);
      const owner = unique('dc_owner');
      const guest = unique('dc_guest');
      try {
        await seedPlayer(owner, 0);
        await seedPlayer(guest, 0);

        const made = await create(owner, 'Back Room', 'Raven');
        const channelId = made.channel.id;
        const code = made.code as string;
        assert(
          made.channel.name === 'Back Room' &&
            made.channel.my_alias === 'Raven' &&
            HANDLE.test(made.channel.my_member_id),
          `create answered ${show(made)}; expected 'Back Room' as 'Raven' under a 16-symbol handle`
        );
        const stored = await channelRow(channelId);
        assert(
          stored?.citizenid === owner &&
            stored.status === 'active' &&
            stored.code === code &&
            stored.name === 'Back Room',
          `mica_darkchat holds ${show(stored)} for channel ${channelId}; expected the owner ` +
            `${owner}, active, code ${code}`
        );
        const ownerRows = await memberRows(channelId, owner);
        assert(
          ownerRows.length === 1 &&
            ownerRows[0].live &&
            ownerRows[0].handle === made.channel.my_member_id,
          `the owner's member rows are ${show(ownerRows)}; expected one live row under the ` +
            `handle the reply gave`
        );

        const spoken = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
        const joined = await join(guest, spoken, 'Moth');
        assert(
          joined.channel.id === channelId &&
            joined.channel.is_owner === false &&
            joined.channel.my_alias === 'Moth' &&
            HANDLE.test(joined.channel.my_member_id),
          `join with '${spoken}' answered ${show(joined)}; expected channel ${channelId}, not ` +
            `owned, as 'Moth'`
        );
        assert(
          joined.code == null,
          `a member who is not the owner was handed the code: ${show(joined)}`
        );
        const guestRows = await memberRows(channelId, guest);
        assert(
          guestRows.length === 1 &&
            guestRows[0].live &&
            guestRows[0].status === 'active' &&
            guestRows[0].alias === 'Moth' &&
            guestRows[0].handle === joined.channel.my_member_id,
          `the guest's member rows are ${show(guestRows)}; expected one live 'Moth' row`
        );

        const body = `the drop is at the pier, ${unique('dc_body')}`;
        const sent = await send(guest, channelId, body);
        assert(
          sent.channel_id === channelId &&
            sent.body === body &&
            sent.alias === 'Moth' &&
            sent.member_id === joined.channel.my_member_id &&
            sent.mine === true &&
            sent.bot === false,
          `send answered ${show(sent)}; expected the body as 'Moth', mine, not a bot's`
        );

        for (const [who, label, mine] of [
          [owner, 'the owner', false],
          [guest, 'the poster', true]
        ] as const) {
          const rows = await read(who, channelId);
          const found = rows.find((row) => row.id === sent.id);
          if (!found) {
            throw new Error(
              `${label} read ${rows.length} message(s), none of them ${sent.id}: ${show(rows)}`
            );
          }
          assert(
            found.body === body &&
              found.alias === 'Moth' &&
              found.member_id === sent.member_id &&
              found.mine === mine &&
              found.bot === false,
            `${label} read ${show(found)}; expected the body as 'Moth' with mine ${mine}`
          );
        }

        const row = await db.row(
          'SELECT `citizenid`, `channel_id`, `author_member_id`, `bot_alias`, `body`, `status` ' +
            'FROM `mica_darkchat_messages` WHERE `id` = ?',
          [sent.id]
        );
        if (!row) throw new Error(`message ${sent.id} is not in mica_darkchat_messages`);
        assert(
          row.citizenid === guest &&
            Number(row.channel_id) === channelId &&
            Number(row.author_member_id) === guestRows[0].id &&
            row.bot_alias == null &&
            row.status === 'active',
          `message ${sent.id} is stored as ${show({ ...row, body: '…' })}; expected the guest's, ` +
            `by member row ${guestRows[0].id}, in channel ${channelId}, active`
        );
        const opened = openSealed(row.body, harnessKeys(), {
          table: 'mica_darkchat_messages',
          column: 'body',
          citizenid: guest,
          scope: [channelId]
        });
        assert(opened === body, `the stored body opened to '${opened}', not what was sent`);
        const count = await db.count(
          'SELECT COUNT(*) FROM `mica_darkchat_messages` WHERE `channel_id` = ?',
          [channelId]
        );
        assert(count === 1, `${count} messages stored for one send`);
      } finally {
        await forget([owner, guest]);
      }
    }
  },
  {
    // MICA-254: anonymity is to the other members, not to staff. Every reply and push either
    // member gets — create, join, the channel list, the members list, both sends, both reads,
    // both message pushes, a report — carries no citizenid and no phone number of either, and
    // names a member only by alias and a random handle, never the member row's integer id. The
    // tables still hold the author, and the report names the reported author and the reporter's
    // alias for staff.
    id: 'darkchat-members-never-learn-who-stands-behind-an-alias',
    mode: 'standalone',
    tickets: ['MICA-254', 'MICA-397'],
    timeoutMs: SCENARIO_MS,
    run: async (signal) => {
      await schemaCreated(signal);
      // `seedCitizen` gives each a phone number, so a reply leaking one has one to leak.
      const a = await seedCitizen('dc_anon_a');
      const b = await seedCitizen('dc_anon_b');
      try {
        await seedPlayer(a.citizenid, 0);
        await seedPlayer(b.citizenid, 0);
        const heard: { to: string; what: string; value: unknown }[] = [];
        const hear = <T>(to: string, what: string, value: T): T => {
          heard.push({ to, what, value });
          return value;
        };

        const made = hear('A', 'create', await create(a.citizenid, 'Cellar', 'Wren'));
        const id = made.channel.id;
        hear('B', 'join', await join(b.citizenid, made.code as string, 'Finch'));
        const fromA = hear('A', 'send', await send(a.citizenid, id, 'first word'));
        const fromB = hear('B', 'send', await send(b.citizenid, id, 'second word'));
        hear(
          'B',
          'push',
          await waitForPush(
            b.citizenid,
            isMessagePush(fromA.id),
            PUSH_WAIT_MS,
            signal,
            `B's push of A's message ${fromA.id}`
          )
        );
        hear(
          'A',
          'push',
          await waitForPush(
            a.citizenid,
            isMessagePush(fromB.id),
            PUSH_WAIT_MS,
            signal,
            `A's push of B's message ${fromB.id}`
          )
        );
        const membersSeenByB = hear('B', 'members', await membersOf(b.citizenid, id));
        hear('A', 'members', await membersOf(a.citizenid, id));
        const channelsOfB = hear('B', 'channels', await channelsOf(b.citizenid));
        hear('A', 'channels', await channelsOf(a.citizenid));
        const readByB = hear('B', 'read', await read(b.citizenid, id));
        hear('A', 'read', await read(a.citizenid, id));

        // The table keeps who wrote what, for staff.
        const [aRow] = await memberRows(id, a.citizenid);
        assert(aRow !== undefined, `no member row for A in channel ${id}`);
        const stored = await db.row(
          'SELECT `citizenid`, `author_member_id` FROM `mica_darkchat_messages` WHERE `id` = ?',
          [fromA.id]
        );
        assert(
          stored?.citizenid === a.citizenid && Number(stored.author_member_id) === aRow.id,
          `A's message ${fromA.id} is stored as ${show(stored)}; expected A's citizenid and ` +
            `member row ${aRow.id}`
        );

        // What B is told about A: the alias and the handle, and the handle is not the row id.
        const seen = readByB.find((message) => message.id === fromA.id);
        if (!seen) throw new Error(`B's read lacks A's message ${fromA.id}: ${show(readByB)}`);
        assert(
          seen.alias === 'Wren' && seen.member_id === aRow.handle && seen.mine === false,
          `B read A's message as ${show(seen)}; expected 'Wren' under handle ${aRow.handle}`
        );
        assert(
          HANDLE.test(aRow.handle) && aRow.handle !== String(aRow.id),
          `A's handle '${aRow.handle}' is not a 16-symbol handle apart from row id ${aRow.id}`
        );
        const listedA = membersSeenByB.find((member) => member.alias === 'Wren');
        assert(
          membersSeenByB.length === 2 && listedA?.id === aRow.handle,
          `B's members list is ${show(membersSeenByB)}; expected two, 'Wren' as ${aRow.handle}`
        );

        // The shapes: nothing beside the declared fields, so no join time and no owner flag.
        for (const member of membersSeenByB) {
          assert(
            keysOf(member) === MEMBER_KEYS,
            `a member reached B as ${show(member)}; expected only ${MEMBER_KEYS}`
          );
        }
        for (const message of readByB) {
          assert(
            keysOf(message) === MESSAGE_KEYS,
            `a message reached B as ${show(message)}; expected only ${MESSAGE_KEYS}`
          );
        }
        for (const channel of channelsOfB) {
          assert(
            keysOf(channel) === CHANNEL_KEYS,
            `a channel reached B as ${show(channel)}; expected only ${CHANNEL_KEYS}`
          );
        }

        // A report from inside: staff get the author and the reporter's alias.
        const { result: filed } = await call<{ id?: unknown; ok?: unknown }>(
          'reports',
          'create',
          b.citizenid,
          { targetTable: 'mica_darkchat_messages', targetId: fromA.id, category: 'other' }
        );
        hear('B', 'report', filed);
        assert(
          typeof filed?.id === 'number' && filed.ok !== false,
          `reports:create answered ${show(filed)}; expected the filed report's id`
        );
        const report = await db.row(
          'SELECT `citizenid`, `target_table`, `target_id`, `target_author`, `reporter_label` ' +
            'FROM `mica_reports` WHERE `id` = ?',
          [filed.id]
        );
        assert(
          report?.citizenid === b.citizenid &&
            report.target_table === 'mica_darkchat_messages' &&
            Number(report.target_id) === fromA.id &&
            report.target_author === a.citizenid &&
            report.reporter_label === 'Finch',
          `the report is stored as ${show(report)}; expected B filing on A's message ` +
            `${fromA.id}, labelled 'Finch'`
        );

        const secrets = [
          ['A citizenid', a.citizenid],
          ['A phone number', a.number],
          ['B citizenid', b.citizenid],
          ['B phone number', b.number]
        ] as const;
        for (const { to, what, value } of heard) {
          const json = show(value);
          for (const [label, secret] of secrets) {
            assert(
              !json.includes(secret),
              `${what} answered to ${to} carries ${label} '${secret}': ${json}`
            );
          }
        }
        assert(heard.length === 13, `${heard.length} replies checked; expected 13`);
      } finally {
        await forget([a.citizenid, b.citizenid]);
      }
    }
  },
  {
    // MICA-254: every failed join is one answer, whatever the reason — a code no channel has, a
    // code of the wrong shape, a code the owner replaced — so a guesser learns nothing from it.
    // A replaced code stops at once and the new one works; only the owner may read or replace
    // the code. A refused join seats nobody.
    id: 'darkchat-a-wrong-or-replaced-code-is-refused-alike',
    mode: 'standalone',
    tickets: ['MICA-254', 'MICA-397'],
    timeoutMs: SCENARIO_MS,
    run: async (signal) => {
      await schemaCreated(signal);
      const owner = unique('dc_code_owner');
      const stranger = unique('dc_code_stranger');
      try {
        await seedPlayer(owner, 0);
        await seedPlayer(stranger, 0);
        const made = await create(owner, 'Attic', 'Lark');
        const id = made.channel.id;
        const first = made.code as string;

        const noSuch = await unusedCode();
        for (const [label, code] of [
          [`a code no channel has (${noSuch})`, noSuch],
          ['a code of the wrong shape', 'NOT-A-CODE!']
        ] as const) {
          const { result } = await invoke(CHANNELS, 'join', stranger, { code, alias: 'Pike' });
          assertRefused(result, BAD_CODE, `join with ${label}`);
        }

        const { result: rotated } = await call<{ code?: unknown }>(CHANNELS, 'rotateCode', owner, {
          channel_id: id
        });
        const second = rotated?.code;
        if (typeof second !== 'string' || !CODE.test(second) || second === first) {
          throw new Error(
            `rotateCode answered ${show(rotated)}; expected a new 8-symbol code, not ${first}`
          );
        }
        const { result: shown } = await call<{ code?: unknown }>(CHANNELS, 'code', owner, {
          channel_id: id
        });
        assert(shown?.code === second, `code answered ${show(shown)} after rotating to ${second}`);
        assert(
          (await channelRow(id))?.code === second,
          `mica_darkchat does not hold the rotated code ${second}`
        );

        const { result: stale } = await invoke(CHANNELS, 'join', stranger, {
          code: first,
          alias: 'Pike'
        });
        assertRefused(stale, BAD_CODE, `join with the replaced code ${first}`);

        const { result: peek } = await invoke(CHANNELS, 'code', stranger, { channel_id: id });
        assertRefused(peek, NOT_OWNER, 'code asked by a citizen who does not own the channel');
        const { result: swap } = await invoke(CHANNELS, 'rotateCode', stranger, {
          channel_id: id
        });
        assertRefused(swap, NOT_OWNER, 'rotateCode asked by a citizen who does not own it');
        assert(
          (await channelRow(id))?.code === second,
          "a stranger's refused rotateCode changed the stored code"
        );

        const before = await memberRows(id, stranger);
        assert(
          before.length === 0,
          `three refused joins left ${before.length} member row(s): ${show(before)}`
        );

        // The positive twin: the same citizen, the current code, seated.
        const joined = await join(stranger, second, 'Pike');
        assert(
          joined.channel.id === id && joined.channel.is_owner === false,
          `join with the current code answered ${show(joined)}; expected channel ${id}`
        );
        const after = await memberRows(id, stranger);
        assert(
          after.length === 1 && after[0].live && after[0].alias === 'Pike',
          `after the good join the stranger's rows are ${show(after)}; expected one live 'Pike'`
        );
      } finally {
        await forget([owner, stranger]);
      }
    }
  },
  {
    // MICA-254: a removed member is told so, and stops reading, posting and listing at once,
    // and cannot rejoin; a member who leaves stops the same way but may rejoin, as a new
    // identity under a new handle, reading their own earlier post as somebody else's. When the
    // owner leaves, the longest-standing live member inherits the channel and its code; when
    // the last member leaves, the channel closes and its code stops working.
    id: 'darkchat-leaving-or-removal-ends-reads-and-posts',
    mode: 'standalone',
    tickets: ['MICA-254', 'MICA-397'],
    timeoutMs: SCENARIO_MS,
    run: async (signal) => {
      await schemaCreated(signal);
      const owner = unique('dc_exit_owner');
      const kite = unique('dc_exit_kite');
      const crow = unique('dc_exit_crow');
      try {
        for (const who of [owner, kite, crow]) await seedPlayer(who, 0);
        const made = await create(owner, 'Loft', 'Heron');
        const id = made.channel.id;
        const code = made.code as string;
        const kiteFirst = await join(kite, code, 'Kite');
        await join(crow, code, 'Crow');
        const before = await send(kite, id, 'said before leaving');

        // Removal.
        const crowHandle = (await membersOf(owner, id)).find((m) => m.alias === 'Crow')?.id;
        assert(typeof crowHandle === 'string', `the owner's members list has no 'Crow'`);
        const { result: removed } = await call<boolean>(CHANNELS, 'removeMember', owner, {
          channel_id: id,
          member_id: crowHandle
        });
        assert(removed === true, `removeMember answered ${show(removed)}; expected true`);
        const told = await waitForPush(
          crow,
          (e) => e.event === 'removed' && Number(e.payload?.channel_id) === id,
          PUSH_WAIT_MS,
          signal,
          `the removed member's 'removed' push for channel ${id}`
        );
        assert(told.app === 'darkchat', `the removal push is for '${told.app}', not darkchat`);
        const crowRows = await memberRows(id, crow);
        assert(
          crowRows.length === 1 && crowRows[0].status === 'removed' && !crowRows[0].live,
          `the removed member's rows are ${show(crowRows)}; expected one, removed, not live`
        );
        for (const [service, action, payload] of [
          [MESSAGES, 'list', { channel_id: id }],
          [MESSAGES, 'send', { channel_id: id, body: 'still here?' }],
          [CHANNELS, 'members', { channel_id: id }]
        ] as const) {
          const { result } = await invoke(service, action, crow, payload);
          assertRefused(result, NOT_MEMBER, `${service}:${action} by the removed member`);
        }
        const crowChannels = await channelsOf(crow);
        assert(
          !crowChannels.some((c) => c.id === id),
          `the removed member still lists channel ${id}: ${show(crowChannels)}`
        );
        const ownerChannels = await channelsOf(owner);
        assert(
          ownerChannels.some((c) => c.id === id && c.is_owner),
          `the owner does not list channel ${id} as theirs: ${show(ownerChannels)}`
        );
        const { result: back } = await invoke(CHANNELS, 'join', crow, { code, alias: 'Crow' });
        assertRefused(back, BAD_CODE, 'the removed member joining again with the live code');
        assert(
          (await memberRows(id, crow)).length === 1,
          'the removed member was seated again by a refused join'
        );

        // Leaving.
        const left = await leave(kite, id);
        assert(left === true, `leave answered ${show(left)}; expected true`);
        const kiteRows = await memberRows(id, kite);
        assert(
          kiteRows.length === 1 && kiteRows[0].status === 'left' && !kiteRows[0].live,
          `the leaver's rows are ${show(kiteRows)}; expected one, left, not live`
        );
        for (const [action, payload] of [
          ['list', { channel_id: id }],
          ['send', { channel_id: id, body: 'one more' }]
        ] as const) {
          const { result } = await invoke(MESSAGES, action, kite, payload);
          assertRefused(result, NOT_MEMBER, `darkchat_messages:${action} by the member who left`);
        }
        const again = await leave(kite, id);
        assert(again === false, `a second leave answered ${show(again)}; expected false`);

        // The positive twin of the removal: a leaver may come back, as somebody new.
        const kiteSecond = await join(kite, code, 'Kite');
        assert(
          kiteSecond.channel.my_member_id !== kiteFirst.channel.my_member_id,
          `the rejoin kept the handle ${kiteFirst.channel.my_member_id}; expected a new one`
        );
        const rejoined = await memberRows(id, kite);
        assert(
          rejoined.length === 2 && !rejoined[0].live && rejoined[1].live,
          `after the rejoin the rows are ${show(rejoined)}; expected the old left and a new live`
        );
        const earlier = (await read(kite, id)).find((m) => m.id === before.id);
        assert(
          earlier !== undefined &&
            earlier.mine === false &&
            earlier.member_id === kiteFirst.channel.my_member_id,
          `after rejoining, the earlier post reads as ${show(earlier)}; expected it under the ` +
            `old handle and not mine`
        );

        // The owner leaves: the longest-standing live member — the rejoined Kite — inherits.
        assert((await leave(owner, id)) === true, 'the owner could not leave');
        const handed = await channelRow(id);
        assert(
          handed?.citizenid === kite && handed.status === 'active',
          `after the owner left the channel is ${show(handed)}; expected it live and Kite's`
        );
        const kiteChannels = await channelsOf(kite);
        assert(
          kiteChannels.some((c) => c.id === id && c.is_owner === true),
          `the heir does not list channel ${id} as theirs: ${show(kiteChannels)}`
        );
        const { result: inherited } = await call<{ code?: unknown }>(CHANNELS, 'code', kite, {
          channel_id: id
        });
        assert(
          inherited?.code === code,
          `the heir's code answered ${show(inherited)}; expected ${code}`
        );
        const { result: former } = await invoke(CHANNELS, 'code', owner, { channel_id: id });
        assertRefused(former, NOT_OWNER, 'code asked by the owner who left');

        // The last member leaves: the channel closes, and its code with it.
        assert((await leave(kite, id)) === true, 'the last member could not leave');
        const closed = await channelRow(id);
        assert(
          closed?.status === 'deleted',
          `with nobody left the channel is ${show(closed)}; expected it deleted`
        );
        const { result: dead } = await invoke(CHANNELS, 'join', owner, { code, alias: 'Heron' });
        assertRefused(dead, BAD_CODE, "join with a closed channel's code");
      } finally {
        await forget([owner, kite, crow]);
      }
    }
  },
  {
    // MICA-254: a post is pushed to every other live member — the message as a reader sees it,
    // and a toast that says only that something arrived, stored nowhere — and not to its
    // sender, who has the reply. A member who has left is pushed nothing more.
    id: 'darkchat-a-post-is-pushed-to-the-other-live-members-only',
    mode: 'standalone',
    tickets: ['MICA-254', 'MICA-397'],
    timeoutMs: SCENARIO_MS,
    run: async (signal) => {
      await schemaCreated(signal);
      const owner = unique('dc_push_owner');
      const poster = unique('dc_push_poster');
      const third = unique('dc_push_third');
      try {
        for (const who of [owner, poster, third]) await seedPlayer(who, 0);
        const made = await create(owner, 'Wharf', 'Gull');
        const id = made.channel.id;
        const code = made.code as string;
        const posterJoined = await join(poster, code, 'Kestrel');
        await join(third, code, 'Tern');
        for (const who of [owner, poster, third]) await pushes(who);

        const body = `meet at nine, ${unique('dc_push_body')}`;
        const sent = await send(poster, id, body);
        for (const [who, label] of [
          [owner, 'the owner'],
          [third, 'the third member']
        ] as const) {
          const envelope = (await waitForPush(
            who,
            isMessagePush(sent.id),
            PUSH_WAIT_MS,
            signal,
            `${label}'s push of message ${sent.id}`
          )) as Envelope;
          const pushed = envelope.payload?.message as Message | undefined;
          assert(
            Number(envelope.payload?.channel_id) === id &&
              pushed?.body === body &&
              pushed.alias === 'Kestrel' &&
              pushed.member_id === posterJoined.channel.my_member_id &&
              pushed.mine === false &&
              pushed.bot === false,
            `${label} was pushed ${show(envelope.payload)}; expected the body as 'Kestrel', ` +
              `not mine, in channel ${id}`
          );
          const toast = envelope.notify;
          assert(
            toast?.title === 'Dark Chat' && toast.message === 'New message',
            `${label}'s toast is ${show(toast)}; expected 'Dark Chat' / 'New message'`
          );
          const toastText = show(toast);
          assert(
            !toastText.includes(body) && !toastText.includes('Kestrel'),
            `${label}'s toast names the body or the alias: ${toastText}`
          );
          assert(
            envelope.persisted === false,
            `${label}'s push says persisted ${show(envelope.persisted)}; expected false`
          );
        }
        const own = (await pushes(poster)).filter(isMessagePush(sent.id));
        assert(own.length === 0, `the sender was pushed their own message: ${show(own)}`);
        const stored = await db.count(
          "SELECT COUNT(*) FROM `mica_notifications` WHERE `app` = 'darkchat' AND `citizenid` IN (?, ?, ?)",
          [owner, poster, third]
        );
        assert(stored === 0, `${stored} Dark Chat notification row(s) stored; expected none`);

        // Leaving stops the pushes: the owner still hears the next post, the leaver does not.
        assert((await leave(third, id)) === true, 'the third member could not leave');
        const next = await send(poster, id, 'and bring the van');
        await waitForPush(
          owner,
          isMessagePush(next.id),
          PUSH_WAIT_MS,
          signal,
          `the owner's push of message ${next.id}`
        );
        // `pushMany` delivers to every recipient in one pass, so once the owner has it the
        // leaver's buffer holds everything it was ever going to.
        const late = (await pushes(third)).filter(isMessagePush(next.id));
        assert(late.length === 0, `the member who left was pushed ${show(late)}`);
      } finally {
        await forget([owner, poster, third]);
      }
    }
  }
];
