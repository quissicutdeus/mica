// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { tablePresent, text, toDate, type ImportContext } from './context';
import { SKIP, Tally, threadTableUnusable, type TableReport } from './report';
import { chronological, countRows, openSource, pages } from './source';
import {
  AccountOwners,
  importAccounts,
  importContacts,
  importMedia,
  importPosts,
  mapPages,
  Threads
} from './write';

/**
 * lb-phone (MICA-233). Everything lb-phone stores is keyed by **phone number**, not by
 * character: contacts belong to `phone_number`, a thread's members are numbers, a photo is a
 * number's. So identity is number → character, through `PlayerDirectory` first and lb-phone's
 * own `phones` table (number → the identifier that owned it) after.
 *
 * lb-phone is escrowed and its SQL ships with the resource rather than a public repo. The
 * column names here are from its `phone.sql` as distributed; the tables are named
 * `phone_<name>`, and some installs carry an `lb_phone_` prefix instead, so both are probed
 * and the first that exists is used. Both prefixes are literals — nothing from the database
 * picks a table name.
 */

const PREFIXES = ['phone_', 'lb_phone_'] as const;
type Prefix = (typeof PREFIXES)[number];

let detected: Promise<Prefix> | null = null;

/** Which prefix this database uses, judged by the table every lb-phone install has. */
const prefix = (): Promise<Prefix> => {
  detected ??= (async () => {
    for (const p of PREFIXES) {
      if (await tablePresent(`${p}phones`)) return p;
    }
    return PREFIXES[0];
  })();
  return detected;
};

/** Test seam: forget the detected prefix. */
export const __resetLbPrefix = (): void => {
  detected = null;
};

/**
 * The identifiers lb-phone recorded against a number: the phone's `id` (the owner's
 * identifier, unless phones are items, in which case it is the item's own id and resolves to
 * nobody) and the last identifier seen using it. Handed to `Resolver`, which believes neither
 * until `PlayerDirectory` finds a character behind it.
 */
export const lbNumberOwners = async (number: string): Promise<string[]> => {
  const p = await prefix();
  const found: string[] = [];
  if (await tablePresent(`${p}phones`)) {
    const rows = await Database.query<{ id: string }[]>(
      p === 'phone_'
        ? 'SELECT `id` FROM `phone_phones` WHERE `phone_number` = ?'
        : 'SELECT `id` FROM `lb_phone_phones` WHERE `phone_number` = ?',
      [number]
    );
    for (const row of rows ?? []) found.push(String(row.id));
  }
  if (await tablePresent(`${p}last_phone`)) {
    const rows = await Database.query<{ identifier: string }[]>(
      p === 'phone_'
        ? 'SELECT `identifier` FROM `phone_last_phone` WHERE `phone_number` = ?'
        : 'SELECT `identifier` FROM `lb_phone_last_phone` WHERE `phone_number` = ?',
      [number]
    );
    for (const row of rows ?? []) found.push(String(row.identifier));
  }
  return found;
};

interface ContactRow {
  contact_phone_number: string;
  firstname: string | null;
  lastname: string | null;
  favourite: number | boolean | null;
  phone_number: string;
}

interface ChannelRow {
  channel_id: string;
  is_group: number | boolean;
  name: string | null;
}

interface MemberRow {
  channel_id: string;
  phone_number: string;
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender: string;
  content: string | null;
  timestamp: unknown;
}

interface PhotoRow {
  phone_number: string;
  link: string;
  is_video: number | boolean | null;
  timestamp: unknown;
}

interface AccountRow {
  username: string;
  display_name: string | null;
  phone_number: string;
  bio: string | null;
  profile_image: string | null;
}

interface TweetRow {
  id: string;
  username: string;
  content: string | null;
  reply_to: string | null;
  timestamp: unknown;
}

export const importLbPhone = async (ctx: ImportContext): Promise<TableReport[]> => {
  const p = await prefix();
  const t = (name: string): string => `${p}${name}`;
  const reports: TableReport[] = [];

  {
    const tally = await openSource(t('phone_contacts'));
    await importContacts(
      ctx,
      tally,
      mapPages(
        pages<ContactRow>(tally, {
          table: t('phone_contacts'),
          columns: ['contact_phone_number', 'firstname', 'lastname', 'favourite', 'phone_number'],
          key: ['contact_phone_number', 'phone_number']
        }),
        (row) => ({
          key: `${text(row.phone_number)}|${text(row.contact_phone_number)}`,
          owner: { number: text(row.phone_number) },
          firstname: text(row.firstname),
          lastname: text(row.lastname) || null,
          phone: text(row.contact_phone_number),
          favorite: Boolean(row.favourite)
        })
      )
    );
    reports.push(tally.toReport());
  }

  {
    const channels = await openSource(t('message_channels'));
    const members = await openSource(t('message_members'));
    const messages = await openSource(t('message_messages'));

    // Member rows are small and grouped by channel; read them all before the channels.
    const membersOf = new Map<string, string[]>();
    for await (const rows of pages<MemberRow>(new Tally(members.table, members.present), {
      table: t('message_members'),
      columns: ['channel_id', 'phone_number'],
      key: ['channel_id', 'phone_number']
    })) {
      for (const row of rows) {
        const list = membersOf.get(String(row.channel_id)) ?? [];
        list.push(text(row.phone_number));
        membersOf.set(String(row.channel_id), list);
      }
    }

    const threads = new Threads(ctx, channels.table, channels, members);
    const opened = new Set<string>();
    await threads.open(
      mapPages(
        pages<ChannelRow>(channels, {
          table: t('message_channels'),
          columns: ['channel_id', 'is_group', 'name'],
          key: ['channel_id']
        }),
        (row) => {
          opened.add(String(row.channel_id));
          return {
            key: String(row.channel_id),
            isGroup: Boolean(row.is_group),
            name: text(row.name) || null,
            members: (membersOf.get(String(row.channel_id)) ?? []).map((number) => ({ number }))
          };
        }
      )
    );
    // Member rows of a channel the channel table does not have are counted, not lost.
    for (const [channel, list] of membersOf) {
      if (opened.has(channel)) continue;
      Threads.skipAll(members, list.length, SKIP.threadNotInTable);
    }

    if (!channels.present || (channels.unreadable && channels.read === 0)) {
      Threads.skipAll(
        messages,
        messages.present ? await countRows(t('message_messages')) : 0,
        threadTableUnusable(channels.table, channels.present)
      );
    } else {
      // Oldest first: micaOS orders a thread by row id, and lb-phone's ids are not in time order.
      await threads.messages(
        messages,
        mapPages(
          chronological<MessageRow>(messages, {
            table: t('message_messages'),
            columns: ['id', 'channel_id', 'sender', 'content', 'timestamp'],
            id: 'id',
            time: 'timestamp'
          }),
          (row) => ({
            key: String(row.id),
            threadKey: String(row.channel_id),
            sender: { number: text(row.sender) },
            body: text(row.content),
            at: toDate(row.timestamp)
          })
        )
      );
    }
    reports.push(channels.toReport(), members.toReport(), messages.toReport());
  }

  {
    const tally = await openSource(t('photos'));
    await importMedia(
      ctx,
      tally,
      mapPages(
        pages<PhotoRow>(tally, {
          table: t('photos'),
          columns: ['phone_number', 'link', 'is_video', 'timestamp'],
          key: ['phone_number', 'link']
        }),
        (row) => ({
          key: `${text(row.phone_number)}|${text(row.link)}`,
          owner: { number: text(row.phone_number) },
          link: text(row.link),
          isVideo: Boolean(row.is_video),
          at: toDate(row.timestamp)
        })
      )
    );
    reports.push(tally.toReport());
  }

  {
    const owners = new AccountOwners();
    const accounts = await openSource(t('twitter_accounts'));
    await importAccounts(
      ctx,
      accounts,
      mapPages(
        pages<AccountRow>(accounts, {
          table: t('twitter_accounts'),
          columns: ['username', 'display_name', 'phone_number', 'bio', 'profile_image'],
          key: ['username']
        }),
        (row) => ({
          key: text(row.username),
          owner: { number: text(row.phone_number) },
          handle: text(row.username),
          displayName: text(row.display_name) || null,
          avatar: text(row.profile_image) || null,
          bio: text(row.bio) || null
        })
      ),
      owners
    );
    const tweets = await openSource(t('twitter_tweets'));
    await importPosts(
      ctx,
      tweets,
      mapPages(
        // Oldest first matters here too: the Blabber feed is ordered by row id.
        chronological<TweetRow>(tweets, {
          table: t('twitter_tweets'),
          columns: ['id', 'username', 'content', 'reply_to', 'timestamp'],
          id: 'id',
          time: 'timestamp'
        }),
        (row) => ({
          key: String(row.id),
          account: { table: accounts.table, key: text(row.username) },
          body: text(row.content),
          at: toDate(row.timestamp),
          replyToKey: row.reply_to ? String(row.reply_to) : null
        })
      ),
      owners
    );
    reports.push(accounts.toReport(), tweets.toReport());
  }

  return reports;
};
