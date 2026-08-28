/**
 * Typed Client-to-Web NUI RPC Payload Validation & Sanitization Layer.
 *
 * FiveM clients and NUI callbacks are untrusted endpoints. Every payload pushed
 * into the web NUI bridge is sanitized, type-narrowed, and strictly validated to prevent
 * DOM XSS, prototype pollution, component crashes, or data corruption.
 */

export interface SetTimePayload {
  hours: number;
  minutes: number;
}

export interface NotifyPayload {
  type: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
}

export interface OpenAppPayload {
  appId: string;
  props?: Record<string, unknown>;
}

export interface UninstallAppPayload {
  appId: string;
}

export interface ReceiveMailPayload {
  id?: number;
  citizenid?: string;
  sender: string;
  sender_address?: string;
  subject: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  read?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ReceiveMessagePayload {
  conversationId?: number;
  message: string;
  senderName?: string;
  phone?: string;
  avatar?: string;
  created_at?: string;
  replyToId?: number;
}

export interface ContactSharePayload {
  firstname?: string;
  lastname?: string;
  phone?: string;
  email?: string;
  avatar?: string;
  favorite?: boolean;
}

export interface CallStatusPayload {
  status: 'connected' | 'idle' | 'incoming';
  number: string;
  name: string;
}

/** Utility primitive sanitizers */

function safeString(val: unknown, maxLen = 1000): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLen);
}

function safeNumber(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return undefined;
}

function safeObject(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

/** Action Payload Parsers */

export function parseSetTime(data: unknown): SetTimePayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const hours = safeNumber(obj.hours ?? obj.hour);
  const minutes = safeNumber(obj.minutes ?? obj.minute);
  if (hours === undefined || minutes === undefined) return null;
  return { hours, minutes };
}

export function parseSetCharge(data: unknown): number | null {
  const val = safeNumber(data);
  if (val === undefined) return null;
  return Math.max(0, Math.min(100, Math.floor(val)));
}

export function parseSetSignal(data: unknown): number | null {
  const val = safeNumber(data);
  if (val === undefined) return null;
  return Math.max(0, Math.min(5, Math.floor(val)));
}

export function parseNotify(data: unknown): NotifyPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const message = safeString(obj.message, 1000);
  if (!message) return null;
  const rawType = safeString(obj.type, 20);
  const type =
    rawType === 'success' || rawType === 'warning' || rawType === 'error' ? rawType : 'info';
  const title = safeString(obj.title, 100);
  return { type, title, message };
}

export function parseOpenApp(data: unknown): OpenAppPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const appId = safeString(obj.appId, 64);
  if (!appId) return null;
  const props = safeObject(obj.props) ?? undefined;
  return { appId, props };
}

export function parseUninstallApp(data: unknown): UninstallAppPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const appId = safeString(obj.appId, 64);
  if (!appId) return null;
  return { appId };
}

export function parseReceiveMail(data: unknown): ReceiveMailPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const sender = safeString(obj.sender, 255) ?? 'Mail';
  const subject = safeString(obj.subject, 255) ?? 'New Message';
  const content = safeString(obj.content, 10000) ?? '';
  const id = safeNumber(obj.id);
  const citizenid = safeString(obj.citizenid, 100);
  const sender_address = safeString(obj.sender_address, 255);
  const rawStatus = safeString(obj.status, 20);
  const status =
    rawStatus === 'active' ||
    rawStatus === 'archived' ||
    rawStatus === 'deleted' ||
    rawStatus === 'moderated'
      ? rawStatus
      : undefined;
  const read = obj.read === true;
  const created_at = safeString(obj.created_at, 100);
  const updated_at = safeString(obj.updated_at, 100);
  return {
    id,
    citizenid,
    sender,
    sender_address,
    subject,
    content,
    status,
    read,
    created_at,
    updated_at
  };
}

export function parseReceiveMessage(data: unknown): ReceiveMessagePayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const conversationId = safeNumber(obj.conversation_id ?? obj.conversationId);
  const message = safeString(obj.message, 2000) ?? '';
  const senderName = safeString(obj.senderName, 100);
  const phone = safeString(obj.phone ?? obj.senderPhone, 50);
  const avatar = safeString(obj.avatar, 2048);
  const created_at = safeString(obj.created_at, 100);
  // `deliverToParticipants` (server/services/Messages.ts) rides the full row under `row`
  // alongside the flattened display fields above — `reply_to_id` only lives there.
  const row = safeObject(obj.row);
  const replyToId = safeNumber(row?.reply_to_id ?? obj.reply_to_id);
  return { conversationId, message, senderName, phone, avatar, created_at, replyToId };
}

export function parseContactShare(data: unknown): ContactSharePayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const firstname = safeString(obj.firstname, 100);
  const phone = safeString(obj.phone, 50);
  const lastname = safeString(obj.lastname, 100);
  const email = safeString(obj.email, 255);
  const avatar = safeString(obj.avatar, 2048);
  const favorite = obj.favorite === true;
  return { firstname, lastname, phone, email, avatar, favorite };
}

export function parseCallStatus(data: unknown): CallStatusPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const rawStatus = safeString(obj.status, 20);
  if (rawStatus !== 'connected' && rawStatus !== 'idle' && rawStatus !== 'incoming') {
    return null;
  }
  const number = safeString(obj.number, 50) ?? '';
  const name = safeString(obj.name, 100) ?? number;
  return { status: rawStatus, number, name };
}

/**
 * The two nearby-music pushes. MICA-111 phase 2.
 *
 * The wire types, the net event and both action names live in `shared/musicBroadcast.ts`,
 * which is also where the reasoning is. What is here is the narrowing, because this is the
 * file that narrows every other NUI payload and a second convention would be worse than a
 * slightly awkward split.
 *
 * They arrive from **different senders on purpose**, which is why they are two payloads
 * and not one. The roster is the server's, relayed by `client/services/Music.ts`: only it
 * knows who is within range of whom and it holds the clock that makes `startedAt` mean
 * anything. The volumes are the game client's alone: it is the only thing that knows how
 * far away anybody is standing this frame, and it recomputes them on a tick far faster
 * than the roster changes.
 *
 * Both are **snapshots, never deltas**. A delta protocol needs a removal message, and a
 * lost removal is music that never stops — an empty roster is the ordinary way a broadcast
 * ends, and a source absent from the volume map is somebody who has walked out of earshot.
 *
 * The two are **keyed differently, on purpose**: a roster row carries both a `token` (the
 * person, and the mute key) and a `source` (a FiveM server id, a connection), and the
 * volume map is keyed on `source` alone, because a server id is the only handle the game
 * client can measure a distance to. The join happens in the shell, on the row that has
 * both. `shared/musicBroadcast.ts` sets out at length why a mute must never key on the
 * server id.
 *
 * Narrowing here is shallow on purpose. The rows carry YouTube ids that end up in an
 * `<iframe src>`, and those are re-validated against `shared/youtube.ts`'s own shapes in
 * `web/src/shell/state/nearbyMusic.ts` — the module that builds the URL, which is where
 * that check belongs rather than two layers above it.
 */

/**
 * The roster, or `null`.
 *
 * An **empty array is a valid payload and the most important one** — it is how "nobody
 * nearby is playing anything" is said, so it must not be confused with a malformed
 * message. `null` is reserved for a payload that was not a roster at all.
 *
 * A bare array is accepted alongside `{ broadcasts }` so the browser dev harness can post
 * the obvious thing without wrapping it.
 */
export function parseMusicBroadcasts(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const obj = safeObject(data);
  const list = obj?.broadcasts;
  if (!Array.isArray(list)) return null;
  return list;
}

/**
 * The per-broadcaster volumes, keyed by `source`, or `null`.
 *
 * Values are left as they arrived and clamped where they are applied, for the same reason
 * the ids are: one module owns what a volume may be, and it is the one that multiplies it
 * into a player. What is enforced here is the *shape* — a plain object, never an array,
 * and with the three keys that are not data stripped, since this map is looked up by a
 * `source` that came off the same wire and `__proto__` reaching a lookup is the one way it
 * could be more than data. Keys are server ids as strings; the shell drops anything that
 * is not one rather than holding a volume no roster row can ever match.
 */
export function parseMusicBroadcastVolumes(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return null;
  const obj = safeObject(data);
  if (!obj) return null;
  const raw = safeObject(obj.volumes) ?? obj;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = raw[key];
  }
  return out;
}
