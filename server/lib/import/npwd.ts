// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { text, toDate, splitName, type ImportContext } from './context';
import { SKIP, Tally, threadTableUnusable, type TableReport } from './report';
import { countRows, openSource, pages } from './source';
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
 * NPWD (MICA-233), from `import.sql` upstream. NPWD keys a player by `identifier` — the
 * framework's own id, which on qb is the citizenid and on ESX the license identifier — and a
 * thread's members by phone number. `visible = 0` is NPWD's soft delete and is not carried
 * over; an embed (a shared contact or location card) has no text of its own and is skipped.
 */

interface ContactRow {
  id: number;
  identifier: string | null;
  number: string | null;
  display: string | null;
}

interface ConversationRow {
  id: number;
  label: string | null;
  is_group_chat: number | boolean;
}

interface ParticipantRow {
  conversation_id: number;
  participant: string;
}

interface MessageRow {
  id: number;
  message: string;
  user_identifier: string;
  conversation_id: string | number;
  createdAt: unknown;
  visible: number | boolean;
  author: string;
  is_embed: number | boolean;
}

interface GalleryRow {
  id: number;
  identifier: string | null;
  image: string;
}

interface ProfileRow {
  id: number;
  profile_name: string;
  identifier: string;
  avatar_url: string | null;
}

interface TweetRow {
  id: number;
  message: string;
  createdAt: unknown;
  visible: number | boolean;
  retweet: number | null;
  profile_id: number;
}

export const importNpwd = async (ctx: ImportContext): Promise<TableReport[]> => {
  const reports: TableReport[] = [];

  {
    const tally = await openSource('npwd_phone_contacts');
    await importContacts(
      ctx,
      tally,
      mapPages(
        pages<ContactRow>(tally, {
          table: 'npwd_phone_contacts',
          columns: ['id', 'identifier', 'number', 'display'],
          key: ['id']
        }),
        (row) => ({
          key: String(row.id),
          owner: { citizenid: row.identifier },
          ...splitName(text(row.display)),
          phone: text(row.number)
        })
      )
    );
    reports.push(tally.toReport());
  }

  {
    const conversations = await openSource('npwd_messages_conversations');
    const participants = await openSource('npwd_messages_participants');
    const messages = await openSource('npwd_messages');

    const membersOf = new Map<string, string[]>();
    for await (const rows of pages<ParticipantRow>(
      new Tally(participants.table, participants.present),
      {
        table: 'npwd_messages_participants',
        columns: ['id', 'conversation_id', 'participant'],
        key: ['id']
      }
    )) {
      for (const row of rows) {
        const list = membersOf.get(String(row.conversation_id)) ?? [];
        list.push(text(row.participant));
        membersOf.set(String(row.conversation_id), list);
      }
    }

    const threads = new Threads(ctx, conversations.table, conversations, participants);
    const opened = new Set<string>();
    await threads.open(
      mapPages(
        pages<ConversationRow>(conversations, {
          table: 'npwd_messages_conversations',
          columns: ['id', 'label', 'is_group_chat'],
          key: ['id']
        }),
        (row) => {
          opened.add(String(row.id));
          return {
            key: String(row.id),
            isGroup: Boolean(Number(row.is_group_chat)),
            name: text(row.label) || null,
            members: (membersOf.get(String(row.id)) ?? []).map((number) => ({ number }))
          };
        }
      )
    );
    for (const [conversation, list] of membersOf) {
      if (opened.has(conversation)) continue;
      Threads.skipAll(participants, list.length, SKIP.threadNotInTable);
    }

    if (!conversations.present || (conversations.unreadable && conversations.read === 0)) {
      Threads.skipAll(
        messages,
        messages.present ? await countRows('npwd_messages') : 0,
        threadTableUnusable(conversations.table, conversations.present)
      );
    } else {
      // NPWD's ids are auto-increment, so id order is time order.
      await threads.messages(
        messages,
        mapPages(
          pages<MessageRow>(messages, {
            table: 'npwd_messages',
            columns: [
              'id',
              'message',
              'user_identifier',
              'conversation_id',
              'createdAt',
              'visible',
              'author',
              'is_embed'
            ],
            key: ['id']
          }),
          (row) => ({
            key: String(row.id),
            threadKey: String(row.conversation_id),
            // The author's identifier is the source's own ownership; the number is not used.
            sender: { citizenid: row.user_identifier, number: text(row.author) },
            body: Number(row.is_embed) ? '' : text(row.message),
            at: toDate(row.createdAt),
            hidden: !Number(row.visible)
          })
        )
      );
    }
    reports.push(conversations.toReport(), participants.toReport(), messages.toReport());
  }

  {
    const tally = await openSource('npwd_phone_gallery');
    await importMedia(
      ctx,
      tally,
      mapPages(
        pages<GalleryRow>(tally, {
          table: 'npwd_phone_gallery',
          columns: ['id', 'identifier', 'image'],
          key: ['id']
        }),
        (row) => ({
          key: String(row.id),
          owner: { citizenid: row.identifier },
          link: text(row.image),
          at: null
        })
      )
    );
    reports.push(tally.toReport());
  }

  {
    const owners = new AccountOwners();
    const profiles = await openSource('npwd_twitter_profiles');
    await importAccounts(
      ctx,
      profiles,
      mapPages(
        pages<ProfileRow>(profiles, {
          table: 'npwd_twitter_profiles',
          columns: ['id', 'profile_name', 'identifier', 'avatar_url'],
          key: ['id']
        }),
        (row) => ({
          key: String(row.id),
          owner: { citizenid: row.identifier },
          handle: text(row.profile_name),
          displayName: text(row.profile_name) || null,
          avatar: text(row.avatar_url) || null
        })
      ),
      owners
    );
    const tweets = await openSource('npwd_twitter_tweets');
    await importPosts(
      ctx,
      tweets,
      mapPages(
        pages<TweetRow>(tweets, {
          table: 'npwd_twitter_tweets',
          columns: ['id', 'message', 'createdAt', 'visible', 'retweet', 'profile_id'],
          key: ['id']
        }),
        (row) => ({
          key: String(row.id),
          account: { table: profiles.table, key: String(row.profile_id) },
          // A retweet repeats the original's text in NPWD; as a mouth it carries none of its own.
          body: row.retweet ? '' : text(row.message),
          at: toDate(row.createdAt),
          mouthOfKey: row.retweet ? String(row.retweet) : null,
          hidden: !Number(row.visible)
        })
      ),
      owners
    );
    reports.push(profiles.toReport(), tweets.toReport());
  }

  return reports;
};
