// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { text, toDate, splitName, type ImportContext } from './context';
import { SKIP, Tally, type TableReport } from './report';
import { openSource, pages } from './source';
import {
  AccountOwners,
  importAccounts,
  importContacts,
  importMedia,
  importPosts,
  mapPages,
  Threads,
  type MessageIn,
  type ThreadIn
} from './write';

/**
 * qb-phone (MICA-233), from `qb-phone.sql` upstream: `player_contacts`, `phone_messages`,
 * `phone_gallery` and `phone_tweets`, all keyed by `citizenid`.
 *
 * `phone_messages` is one row per (owner, other number), with the whole history in a JSON
 * column, and **each side holds its own copy**. A message's ledger key is therefore built from
 * what both copies share — the pair of citizens, the day, the time, the sender, the text and
 * its position among identical ones — so the second copy is recognised rather than written
 * twice. The JSON shape is qb-phone's server `messages` table as the Lua writes it:
 * `[{ date: 'DD-MM-YYYY', messages: [{ message, time: 'HH:MM', sender, type, data }] }]`.
 * That shape is read from the resource's Lua, not from its SQL, and is the likeliest place
 * for a fork to differ; a row it cannot read is skipped with a reason, never guessed at.
 */

interface ContactRow {
  id: number;
  citizenid: string | null;
  name: string | null;
  number: string | null;
}

interface MessageRow {
  id: number;
  citizenid: string | null;
  number: string | null;
  messages: string | null;
}

interface GalleryRow {
  citizenid: string;
  image: string;
  date: unknown;
}

interface TweetRow {
  id: number;
  citizenid: string | null;
  firstName: string | null;
  lastName: string | null;
  message: string | null;
  date: unknown;
}

/** `DD-MM-YYYY` and `HH:MM`, the format qb-phone stamps both with. */
export const qbTimestamp = (date: unknown, time: unknown): Date | null => {
  const d = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(text(date));
  if (!d) return toDate(date);
  const t = /^(\d{1,2}):(\d{2})/.exec(text(time));
  const at = new Date(
    Number(d[3]),
    Number(d[2]) - 1,
    Number(d[1]),
    t ? Number(t[1]) : 0,
    t ? Number(t[2]) : 0
  );
  return Number.isNaN(at.getTime()) ? null : at;
};

/** One `phone_messages` row's history, or null when it is not the shape above. */
export const parseQbMessages = (
  raw: string | null
): { sender: string; body: string; date: string; time: string }[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: { sender: string; body: string; date: string; time: string }[] = [];
  for (const day of parsed) {
    if (!day || typeof day !== 'object' || !Array.isArray((day as any).messages)) return null;
    for (const entry of (day as any).messages as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const type = text(e.type) || 'message';
      out.push({
        sender: text(e.sender),
        // A picture or a location has no text of its own to carry over.
        body: type === 'message' ? text(e.message) : '',
        date: text((day as any).date),
        time: text(e.time)
      });
    }
  }
  return out;
};

async function* once<T>(items: T[]): AsyncGenerator<T[]> {
  if (items.length > 0) yield items;
}

export const importQbPhone = async (ctx: ImportContext): Promise<TableReport[]> => {
  const reports: TableReport[] = [];

  // Contacts.
  {
    const tally = await openSource('player_contacts');
    await importContacts(
      ctx,
      tally,
      mapPages(
        pages<ContactRow>(tally, {
          table: 'player_contacts',
          columns: ['id', 'citizenid', 'name', 'number'],
          key: ['id']
        }),
        (row) => ({
          key: String(row.id),
          owner: { citizenid: row.citizenid },
          ...splitName(text(row.name)),
          phone: text(row.number)
        })
      )
    );
    reports.push(tally.toReport());
  }

  // Messages, one thread per pair of citizens, a page of rows at a time.
  {
    const tally = await openSource('phone_messages');
    const threads = new Threads(ctx, 'phone_messages#threads', null, null);
    for await (const rows of pages<MessageRow>(tally, {
      table: 'phone_messages',
      columns: ['id', 'citizenid', 'number', 'messages'],
      key: ['id']
    })) {
      const opened: ThreadIn[] = [];
      const messages: MessageIn[] = [];
      for (const row of rows) {
        const history = parseQbMessages(row.messages);
        if (!history) {
          tally.readRow();
          tally.skip(SKIP.unparseable);
          continue;
        }
        const owner = await ctx.resolver.citizen(row.citizenid);
        const other = await ctx.resolver.number(row.number);
        const pairKey =
          owner && other
            ? [owner, other].sort().join('|')
            : `${text(row.citizenid)}|${text(row.number)}`;
        opened.push({
          key: pairKey,
          isGroup: false,
          members: [{ citizenid: row.citizenid }, { number: row.number }]
        });
        const ordinals = new Map<string, number>();
        for (const m of history) {
          const base = `${pairKey}|${m.date}|${m.time}|${m.sender}|${m.body}`;
          const n = (ordinals.get(base) ?? 0) + 1;
          ordinals.set(base, n);
          messages.push({
            key: `${base}|#${n}`,
            threadKey: pairKey,
            sender: { citizenid: m.sender },
            body: m.body,
            at: qbTimestamp(m.date, m.time)
          });
        }
      }
      await threads.open(once(opened));
      await threads.messages(tally, once(messages));
    }
    reports.push(tally.toReport());
  }

  // Gallery. No primary key upstream, so it pages by offset and the row is its own key.
  {
    const tally = await openSource('phone_gallery');
    await importMedia(
      ctx,
      tally,
      mapPages(
        pages<GalleryRow>(tally, {
          table: 'phone_gallery',
          columns: ['citizenid', 'image', 'date'],
          key: null
        }),
        (row) => ({
          key: `${text(row.citizenid)}|${text(row.image)}|${String(toDate(row.date)?.getTime() ?? '')}`,
          owner: { citizenid: row.citizenid },
          link: text(row.image),
          at: toDate(row.date)
        })
      )
    );
    reports.push(tally.toReport());
  }

  // Tweets. qb-phone has no accounts: each author gets one Blabber account, named for them.
  // Two passes: the authors first (one entry each, however many tweets), then the tweets.
  {
    const tally = await openSource('phone_tweets');
    const spec = {
      table: 'phone_tweets',
      columns: ['id', 'citizenid', 'firstName', 'lastName', 'message', 'date'],
      key: ['id']
    };
    const authors = new Map<string, string>();
    for await (const rows of pages<TweetRow>(new Tally('phone_tweets', tally.present), spec)) {
      for (const row of rows) {
        const cid = text(row.citizenid);
        if (cid && !authors.has(cid)) {
          authors.set(cid, `${text(row.firstName)} ${text(row.lastName)}`.trim());
        }
      }
    }
    const owners = new AccountOwners();
    // Counted on a scratch tally: the accounts are a by-product of the tweets, and every tweet
    // whose author got none is reported below as such.
    await importAccounts(
      ctx,
      new Tally('phone_tweets#authors', true),
      once(
        [...authors.entries()].map(([cid, display]) => ({
          key: cid,
          owner: { citizenid: cid },
          handle: display.replace(/\s+/g, '_') || cid,
          displayName: display || null
        }))
      ),
      owners
    );
    await importPosts(
      ctx,
      tally,
      mapPages(pages<TweetRow>(tally, spec), (row) => ({
        key: String(row.id),
        account: { table: 'phone_tweets#authors', key: text(row.citizenid) },
        body: text(row.message),
        at: toDate(row.date)
      })),
      owners
    );
    reports.push(tally.toReport());
  }

  return reports;
};
