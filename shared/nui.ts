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

export interface InstallAppPayload {
  url: string;
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

export function parseInstallApp(data: unknown): InstallAppPayload | null {
  const obj = safeObject(data);
  if (!obj) return null;
  const url = safeString(obj.url, 2048);
  if (!url) return null;
  return { url };
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
