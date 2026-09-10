// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The moderation ledger's one sink outside the server (MICA-242).
 *
 * NPWD and lb-phone both post to Discord, because that is where FiveM staff actually run
 * moderation from. `AuditLogger` is the ledger; this is a mirror of the part of it that a
 * staff channel wants to see, posted as embeds to a webhook the owner names in
 * `mica_discord_webhook`. Empty — the default — means off, and every function here is a
 * no-op that costs one `GetConvar`.
 *
 * Three properties the ticket makes non-negotiable, and every branch below keeps:
 *
 * - **Nothing here ever throws into a request path.** `forwardAudit` and `forwardPayment`
 *   return `void` synchronously and swallow everything; a webhook failure never fails the
 *   write that occasioned the audit entry.
 * - **A failed post is logged once and dropped.** Discord being down, a deleted webhook, a
 *   429 — the batch is gone and the console says so exactly once, until a post succeeds
 *   again. Nothing is retried, so a dead webhook cannot turn into a loop.
 * - **No content leaves the server unless `mica_discord_webhook_content` is on.** Off by
 *   default, an embed carries ids, actor, target, action and timestamp only. The `details`
 *   column is the one place a moderation reason or a report id lives, and it is the one
 *   field the gate covers.
 *
 * Delivery is batched and rate limited against Discord's documented shape — roughly five
 * requests per two seconds per webhook, at most ten embeds per message. Events wait a short
 * coalescing delay so a `queue` read that logs twenty `viewed` rows leaves as two posts, not
 * twenty, and the limiter holds a sliding window of send times so a burst past five posts
 * simply waits for the oldest to age out.
 *
 * HTTP is the runtime's global `fetch`: FXServer runs Node 22 (`node_version '22'` in the
 * manifest), which has it, and nothing else in `server/` makes an outbound HTTP call to
 * match. The server tsconfig deliberately has neither `dom` nor `@types/node` in scope, so
 * the minimal shape this module relies on is declared below rather than pulling a lib in.
 */

import type { AuditLogOptions } from './AuditLogger';

export const WEBHOOK_CONVAR = 'mica_discord_webhook';
export const PAYMENT_MIN_CONVAR = 'mica_discord_webhook_payment_min';
export const CONTENT_CONVAR = 'mica_discord_webhook_content';

export const DEFAULT_PAYMENT_MIN = 10_000;

/** Discord's ceiling on embeds in one webhook message. */
export const MAX_EMBEDS_PER_POST = 10;
/** Discord's per-webhook budget, roughly: five requests in any two-second window. */
export const RATE_WINDOW_MS = 2_000;
export const RATE_MAX_POSTS = 5;
/**
 * How long a freshly queued event waits for company before the post goes out. Long enough
 * that a burst from one request coalesces, short enough that a staff channel still reads as
 * live.
 */
export const COALESCE_MS = 250;
/**
 * Pending embeds are capped so a flooded webhook cannot grow the queue without bound; past
 * this the oldest are dropped and the drop is counted rather than each one logged.
 */
export const MAX_PENDING = 100;

/** The subset of Discord's embed object this module writes. */
export interface DiscordEmbed {
  title: string;
  color: number;
  timestamp: string;
  fields: { name: string; value: string; inline?: boolean }[];
}

/** What `fetch` has to look like for this module; the runtime's global satisfies it. */
export type WebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

declare const fetch: WebhookFetch;

/** Discord's field value limit; anything longer is refused with a 400, which would drop the batch. */
const FIELD_MAX = 1024;

const COLOR_MODERATION = 0xd32f2f;
const COLOR_VIEWED = 0xf9a825;
const COLOR_REPORT = 0x1976d2;
const COLOR_PAYMENT = 0x2e7d32;

const webhookUrl = (): string => {
  const raw = GetConvar(WEBHOOK_CONVAR, '').trim();
  return raw.startsWith('https://') ? raw : '';
};

const contentAllowed = (): boolean => {
  const raw = GetConvar(CONTENT_CONVAR, '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
};

export const paymentMin = (): number => {
  const raw = Number.parseInt(GetConvar(PAYMENT_MIN_CONVAR, String(DEFAULT_PAYMENT_MIN)), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PAYMENT_MIN;
};

/**
 * Which ledger entries a staff channel is for.
 *
 * Every moderation write and every admin read of reported content; not a player archiving
 * their own mail or deleting their own contact, which is theirs and nobody's business. The
 * one `deleted` that is a moderation act is `conversations` — its member path logs `left`,
 * so a `deleted` there is always the admin branch (`Conversations.ts`). Everything else
 * `deleted` is the owner acting on an owned row.
 */
export const isStaffRelevant = (entry: AuditLogOptions): boolean => {
  switch (entry.action) {
    case 'moderated':
    case 'unmoderated':
    case 'viewed':
      return true;
    case 'deleted':
      return entry.service === 'conversations';
    default:
      return false;
  }
};

const truncate = (value: string): string =>
  value.length > FIELD_MAX ? `${value.slice(0, FIELD_MAX - 1)}…` : value;

const detailsField = (details: unknown): string => {
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  return truncate(text || '—');
};

const auditEmbed = (entry: AuditLogOptions, at: Date): DiscordEmbed => {
  const target = entry.targetTable
    ? `${entry.targetTable} #${entry.targetId}`
    : `#${entry.targetId}`;
  const fields: DiscordEmbed['fields'] = [
    { name: 'Action', value: `${entry.action} · ${entry.service}.${entry.method}`, inline: true },
    { name: 'Actor', value: entry.citizenid, inline: true },
    { name: 'Target', value: target, inline: true }
  ];
  if (entry.details !== undefined && entry.details !== null && contentAllowed()) {
    fields.push({ name: 'Details', value: detailsField(entry.details) });
  }
  return {
    title: entry.action === 'viewed' ? 'Reported content viewed' : 'Moderation',
    color: entry.action === 'viewed' ? COLOR_VIEWED : COLOR_MODERATION,
    timestamp: at.toISOString(),
    fields
  };
};

export interface PaymentEvent {
  from: string;
  to: string;
  amount: number;
  /** Which balance or path moved the money — `bank`, `cash`, `society`. */
  service: string;
  /** The transfer's own reason string. Content: only forwarded under the content gate. */
  reason?: string;
}

const paymentEmbed = (event: PaymentEvent, at: Date): DiscordEmbed => {
  const fields: DiscordEmbed['fields'] = [
    { name: 'Amount', value: String(event.amount), inline: true },
    { name: 'From', value: event.from, inline: true },
    { name: 'To', value: event.to, inline: true },
    { name: 'Via', value: event.service, inline: true }
  ];
  if (event.reason && contentAllowed()) {
    fields.push({ name: 'Reason', value: truncate(event.reason) });
  }
  return { title: 'Large payment', color: COLOR_PAYMENT, timestamp: at.toISOString(), fields };
};

export interface ReportFiledEvent {
  reportId: number;
  citizenid: string;
  targetTable: string;
  targetId: number;
  category: string;
  /** The reporter's note. Content: only forwarded under the content gate. */
  note?: string;
}

const reportEmbed = (event: ReportFiledEvent, at: Date): DiscordEmbed => {
  const fields: DiscordEmbed['fields'] = [
    { name: 'Report', value: `#${event.reportId} · ${event.category}`, inline: true },
    { name: 'Reporter', value: event.citizenid, inline: true },
    { name: 'Target', value: `${event.targetTable} #${event.targetId}`, inline: true }
  ];
  if (event.note && contentAllowed()) {
    fields.push({ name: 'Note', value: truncate(event.note) });
  }
  return { title: 'Report filed', color: COLOR_REPORT, timestamp: at.toISOString(), fields };
};

// ---------------------------------------------------------------------------------------------
// Queue, batching, rate limit
// ---------------------------------------------------------------------------------------------

let pending: DiscordEmbed[] = [];
let dropped = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Send times inside the current window, oldest first. */
let sentAt: number[] = [];
/** Whether the console has already heard that posts are failing. Cleared by a success. */
let failureLogged = false;
let inFlight = false;

const now = (): number => Date.now();

/** When the limiter next allows a post, as a delay from now. */
const nextSlotIn = (): number => {
  const t = now();
  sentAt = sentAt.filter((s) => t - s < RATE_WINDOW_MS);
  if (sentAt.length < RATE_MAX_POSTS) return 0;
  return Math.max(0, sentAt[0] + RATE_WINDOW_MS - t);
};

const schedule = (delay: number): void => {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, delay);
};

const flush = async (): Promise<void> => {
  if (inFlight) return;
  if (pending.length === 0) return;
  const wait = nextSlotIn();
  if (wait > 0) {
    schedule(wait);
    return;
  }
  const url = webhookUrl();
  if (!url) {
    // Turned off between enqueue and flush: honour it, and do not hold the events.
    pending = [];
    dropped = 0;
    return;
  }

  const batch = pending.splice(0, MAX_EMBEDS_PER_POST);
  const droppedNote = dropped;
  dropped = 0;
  sentAt.push(now());
  inFlight = true;
  try {
    const body: { embeds: DiscordEmbed[]; content?: string } = { embeds: batch };
    if (droppedNote > 0) {
      body.content = `⚠️ ${droppedNote} audit event(s) were dropped before this post: the queue was full.`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      failOnce(`Discord answered ${response.status}`);
    } else {
      failureLogged = false;
    }
  } catch (error) {
    failOnce(error instanceof Error ? error.message : String(error));
  } finally {
    inFlight = false;
  }
  if (pending.length > 0) schedule(Math.max(COALESCE_MS, nextSlotIn()));
};

const failOnce = (why: string): void => {
  if (failureLogged) return;
  failureLogged = true;
  console.error(
    `[DiscordWebhook] Post failed and the batch was dropped (${why}). ` +
      'Further failures are silent until a post succeeds; check the URL in ' +
      `${WEBHOOK_CONVAR}.`
  );
};

const enqueue = (embed: DiscordEmbed): void => {
  if (pending.length >= MAX_PENDING) {
    pending.shift();
    dropped += 1;
  }
  pending.push(embed);
  schedule(Math.max(COALESCE_MS, nextSlotIn()));
};

/** Wraps an entry point so that nothing — a convar read, a clock, a bug — escapes it. */
const guarded = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    console.error('[DiscordWebhook] Dropped an event:', error);
  }
};

// ---------------------------------------------------------------------------------------------
// Entry points. All synchronous, all void, none throw.
// ---------------------------------------------------------------------------------------------

/**
 * Mirror a ledger entry to the staff channel, if it is one the channel is for and the
 * webhook is configured. Called by `AuditLogger.log` on every entry; the filter lives here.
 */
export const forwardAudit = (entry: AuditLogOptions): void =>
  guarded(() => {
    if (!webhookUrl()) return;
    if (!isStaffRelevant(entry)) return;
    enqueue(auditEmbed(entry, new Date(now())));
  });

/**
 * Announce a payment at or above `mica_discord_webhook_payment_min`. The audit ledger never
 * sees money move — `server/lib/Payments.ts` logs to the console only — so its three
 * functions call this directly, after the credit has landed and never on a refund.
 */
export const forwardPayment = (event: PaymentEvent): void =>
  guarded(() => {
    if (!webhookUrl()) return;
    if (!Number.isFinite(event.amount) || event.amount < paymentMin()) return;
    enqueue(paymentEmbed(event, new Date(now())));
  });

/**
 * Announce a report filing. `reports:create` writes no ledger row either, so `Reports.ts`
 * calls this directly once the row is in.
 */
export const forwardReportFiled = (event: ReportFiledEvent): void =>
  guarded(() => {
    if (!webhookUrl()) return;
    enqueue(reportEmbed(event, new Date(now())));
  });

/** Test seam: forget every queued embed, timer and limiter state. */
export const __resetDiscordWebhook = (): void => {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending = [];
  dropped = 0;
  sentAt = [];
  failureLogged = false;
  inFlight = false;
};
