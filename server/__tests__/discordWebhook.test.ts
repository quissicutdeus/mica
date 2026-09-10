// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  forwardAudit,
  forwardPayment,
  forwardReportFiled,
  isStaffRelevant,
  __resetDiscordWebhook,
  COALESCE_MS,
  RATE_WINDOW_MS,
  RATE_MAX_POSTS,
  MAX_EMBEDS_PER_POST,
  MAX_PENDING,
  WEBHOOK_CONVAR,
  CONTENT_CONVAR,
  PAYMENT_MIN_CONVAR
} from '../lib/DiscordWebhook';
import type { AuditLogOptions } from '../lib/AuditLogger';

/**
 * The Discord mirror of the moderation ledger (MICA-242). Everything here runs on fake
 * timers and a fake `fetch`: a real post is deliberately never made, and the four
 * properties the ticket names — payload shape, the content gate, batching plus the rate
 * limiter, and a failed post logging once — are each pinned below.
 */

const URL = 'https://discord.com/api/webhooks/1/abc';

const convars = new Map<string, string>();
const fetchMock = vi.fn();

const moderation = (over: Partial<AuditLogOptions> = {}): AuditLogOptions => ({
  citizenid: 'ADMIN_1',
  action: 'moderated',
  service: 'reports',
  method: 'resolve',
  targetId: 42,
  targetTable: 'mica_media',
  details: 'harassment',
  ...over
});

/** Bodies of every post so far, oldest first. */
const posts = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));

beforeEach(() => {
  vi.useFakeTimers();
  convars.clear();
  convars.set(WEBHOOK_CONVAR, URL);
  (globalThis as any).GetConvar = (name: string, fallback: string) => convars.get(name) ?? fallback;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 204 });
  (globalThis as any).fetch = fetchMock;
  __resetDiscordWebhook();
});

afterEach(() => {
  __resetDiscordWebhook();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('off by default', () => {
  it('posts nothing when the convar is empty', async () => {
    convars.delete(WEBHOOK_CONVAR);
    forwardAudit(moderation());
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a URL that is not https', async () => {
    convars.set(WEBHOOK_CONVAR, 'http://discord.com/api/webhooks/1/abc');
    forwardAudit(moderation());
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('which ledger entries are forwarded', () => {
  it('moderation writes and admin reads, and the admin conversation delete', () => {
    expect(isStaffRelevant(moderation())).toBe(true);
    expect(isStaffRelevant(moderation({ action: 'unmoderated', method: 'reopen' }))).toBe(true);
    expect(isStaffRelevant(moderation({ action: 'viewed', method: 'queue' }))).toBe(true);
    expect(
      isStaffRelevant(moderation({ action: 'deleted', service: 'conversations', method: 'delete' }))
    ).toBe(true);
  });

  it("not a player's own deletes, archives or leaves", () => {
    for (const [action, service] of [
      ['deleted', 'contacts'],
      ['deleted', 'messages'],
      ['archived', 'mail'],
      ['unarchived', 'mail'],
      ['left', 'conversations'],
      ['removed', 'conversations']
    ] as const) {
      expect(isStaffRelevant(moderation({ action, service }))).toBe(false);
    }
  });
});

describe('payload shape', () => {
  it('posts JSON embeds carrying action, actor, target and timestamp', async () => {
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
    forwardAudit(moderation());
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.content).toBeUndefined();
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Moderation');
    expect(embed.timestamp).toBe('2026-09-09T12:00:00.000Z');
    expect(embed.fields).toEqual([
      { name: 'Action', value: 'moderated · reports.resolve', inline: true },
      { name: 'Actor', value: 'ADMIN_1', inline: true },
      { name: 'Target', value: 'mica_media #42', inline: true }
    ]);
  });

  it('titles an admin read distinctly from a write', async () => {
    forwardAudit(moderation({ action: 'viewed', method: 'queue', details: { reportId: 7 } }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(posts()[0].embeds[0].title).toBe('Reported content viewed');
  });

  it('a report filing carries id, reporter, target and category', async () => {
    forwardReportFiled({
      reportId: 9,
      citizenid: 'CIT_B',
      targetTable: 'mica_messages',
      targetId: 3,
      category: 'spam',
      note: 'they keep sending this'
    });
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const embed = posts()[0].embeds[0];
    expect(embed.title).toBe('Report filed');
    expect(embed.fields.map((f: any) => f.name)).toEqual(['Report', 'Reporter', 'Target']);
    expect(embed.fields[0].value).toBe('#9 · spam');
  });
});

describe('the content gate', () => {
  it('leaves details out by default', async () => {
    forwardAudit(moderation({ details: 'the message body quoted here' }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const text = fetchMock.mock.calls[0][1].body as string;
    expect(text).not.toContain('message body');
  });

  it('includes details, a report note and a payment reason only when on', async () => {
    convars.set(CONTENT_CONVAR, '1');
    convars.set(PAYMENT_MIN_CONVAR, '0');
    forwardAudit(moderation({ details: { reason: 'harassment' } }));
    forwardReportFiled({
      reportId: 1,
      citizenid: 'CIT_B',
      targetTable: 'mica_messages',
      targetId: 3,
      category: 'other',
      note: 'reporter note'
    });
    forwardPayment({ from: 'A', to: 'B', amount: 5, service: 'bank', reason: 'rent' });
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const [audit, report, payment] = posts()[0].embeds;
    expect(audit.fields.at(-1)).toEqual({ name: 'Details', value: '{"reason":"harassment"}' });
    expect(report.fields.at(-1)).toEqual({ name: 'Note', value: 'reporter note' });
    expect(payment.fields.at(-1)).toEqual({ name: 'Reason', value: 'rent' });
  });

  it('truncates a detail to what Discord accepts in one field', async () => {
    convars.set(CONTENT_CONVAR, 'true');
    forwardAudit(moderation({ details: 'x'.repeat(5000) }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const value = posts()[0].embeds[0].fields.at(-1).value as string;
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.endsWith('…')).toBe(true);
  });
});

describe('payments', () => {
  const pay = (amount: number) => forwardPayment({ from: 'A', to: 'B', amount, service: 'bank' });

  it('announces at or above the default threshold and not below', async () => {
    pay(9_999);
    pay(10_000);
    pay(250_000);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const embeds = posts()[0].embeds;
    expect(embeds.map((e: any) => e.fields[0].value)).toEqual(['10000', '250000']);
    expect(embeds[0].title).toBe('Large payment');
    expect(embeds[0].fields.map((f: any) => f.name)).toEqual(['Amount', 'From', 'To', 'Via']);
  });

  it('reads the threshold from its convar, falling back on garbage', async () => {
    convars.set(PAYMENT_MIN_CONVAR, '500');
    pay(600);
    convars.set(PAYMENT_MIN_CONVAR, 'lots');
    pay(600);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(posts()[0].embeds).toHaveLength(1);
  });
});

describe('batching and the rate limiter', () => {
  it('coalesces a burst into one post of at most ten embeds', async () => {
    for (let i = 0; i < 12; i++) forwardAudit(moderation({ targetId: i }));
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts()[0].embeds).toHaveLength(MAX_EMBEDS_PER_POST);

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posts()[1].embeds).toHaveLength(2);
    // Order preserved across the split.
    expect(posts()[1].embeds[0].fields[2].value).toBe('mica_media #10');
  });

  it('never exceeds five posts in any two-second window', async () => {
    // Sixty events: six posts' worth. The sixth has to wait for the window.
    for (let i = 0; i < 60; i++) forwardAudit(moderation({ targetId: i }));
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(RATE_MAX_POSTS);

    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(RATE_MAX_POSTS + 1);
    expect(posts().flatMap((p) => p.embeds)).toHaveLength(60);
  });

  it('caps the queue and says how many it dropped, in the next post', async () => {
    for (let i = 0; i < MAX_PENDING + 3; i++) forwardAudit(moderation({ targetId: i }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const first = posts()[0];
    expect(first.content).toContain('3 audit event(s) were dropped');
    // The oldest three went; the post starts at the fourth.
    expect(first.embeds[0].fields[2].value).toBe('mica_media #3');
  });
});

describe('a failed post', () => {
  it('is logged once, dropped, and never retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    forwardAudit(moderation({ targetId: 1 }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    forwardAudit(moderation({ targetId: 2 }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS * 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('ECONNREFUSED');
    expect(error.mock.calls[0][0]).toContain(WEBHOOK_CONVAR);
  });

  it('treats a non-2xx answer the same, and speaks again after a success', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    forwardAudit(moderation({ targetId: 1 }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('429');

    forwardAudit(moderation({ targetId: 2 }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(error).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    forwardAudit(moderation({ targetId: 3 }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('never throws into the caller, even when the convar read does', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as any).GetConvar = () => {
      throw new Error('no runtime');
    };
    expect(() => forwardAudit(moderation())).not.toThrow();
    expect(() =>
      forwardPayment({ from: 'A', to: 'B', amount: 1e9, service: 'bank' })
    ).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});
