import {
  mockContacts,
  mockConversations,
  mockEmails,
  mockMessages,
  mockNotes,
  mockPhotos,
  sampleAvatars
} from './data';
import type {
  Account,
  Blab,
  BlabberDm,
  Contact,
  Conversation,
  Mail,
  Message,
  Note,
  Photo,
  Transaction
} from '@shared/types';
import { defineMockCrud } from './defineMockCrud';

// Helper to simulate delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type MockHandler<T = any> = (data?: any) => Promise<T> | T;

let mockPhotoIndex = 5;

const mockReports: any[] = [
  {
    id: 1,
    citizenid: 'REPORTER',
    target_table: 'gphone_messages',
    target_id: 4,
    category: 'harassment',
    note: 'Kept messaging after I asked them to stop.',
    resolution: 'pending',
    target_preview: 'you are going to regret that',
    target_author: 'AUTHOR1',
    status: 'active',
    created_at: '2026-07-30T10:00:00Z',
    updated_at: '2026-07-30T10:00:00Z'
  }
];

/**
 * Blabber's mock state: three accounts — two the player owns, one they do not — and a short feed.
 *
 * Hand-written rather than through `defineMockCrud`, because the feed is a **paged public**
 * read and answers `{ rows, nextCursor }`. A mock that returned a bare array would let the app
 * look fine in `pnpm dev` while being wrong against the real server — the exact failure mode
 * the route table exists to outlaw.
 */
const mockAccounts: Account[] = [
  {
    id: 1,
    app: 'blabber',
    handle: 'ada',
    display_name: 'Ada',
    status: 'active',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z'
  },
  {
    id: 2,
    app: 'blabber',
    handle: 'nightowl',
    display_name: 'Night Owl',
    status: 'active',
    created_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z'
  },
  {
    id: 4,
    app: 'blabber',
    handle: 'ada_alt',
    display_name: null,
    status: 'active',
    created_at: '2026-08-03T10:00:00Z',
    updated_at: '2026-08-03T10:00:00Z'
  }
];

/**
 * `?state=fresh` presents the phone as never used before.
 *
 * Without it the first-run experience was **unreachable in the browser**: the fixtures always hold
 * data, so Blabber's claim gate — the screen that asks for your first handle, and the only thing a
 * new player sees — never rendered in `pnpm dev` or under Playwright. A path no developer can look
 * at is a path that rots, and this one is every player's first impression.
 *
 * **One axis, not a list of app ids.** This began as `?fresh=blabber`, which made the ordinary
 * invocation repeat the id it had just handed `?app=` — `?app=blabber&fresh=blabber` — to buy
 * per-app independence nothing asked for. Whether the data is fresh is orthogonal to which app you
 * open, so it reads as `?app=blabber&state=fresh`. An app that later grows its own notion of prior
 * use reads the same flag and needs no entry anywhere.
 *
 * **Not the default for `?app=`, deliberately.** Opening an app to look at a populated feed is the
 * ordinary case — every other spec in `e2e/apps/` needs one — so a deep link that always started
 * empty would take away the thing the harness is mostly for.
 *
 * Dev-only in the sense that nothing in the game supplies a query string.
 */
const startFresh =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('state')) === 'fresh';

/**
 * Which of those the player owns.
 *
 * The mock had no notion of ownership at all — `getMyAccounts` filtered by `app` alone, so every
 * account in the fixture came back as the player's. Two consequences, both invisible in the
 * browser: every profile rendered as your own, and the DM fixture had @nightowl messaging an
 * account it supposedly *was*. The server has always answered this from `citizenid`, so a mock
 * that cannot say no is a mock that hides whatever depends on the answer.
 *
 * Two owned accounts rather than one, because switching identity needs something to switch to,
 * and two of a cap of three leaves room to claim another.
 */
const mockOwnedAccountIds = new Set<number>(startFresh ? [] : [1, 4]);

const mockBlabs: Blab[] = [
  {
    id: 3,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'traffic on the interstate is unreal today #losangeles',
    reply_to: null,
    status: 'active',
    created_at: '2026-08-02T12:00:00Z',
    updated_at: '2026-08-02T12:00:00Z'
  },
  {
    id: 2,
    account_id: 2,
    handle: 'nightowl',
    display_name: 'Night Owl',
    body: 'anyone up? @ada',
    reply_to: null,
    status: 'active',
    created_at: '2026-08-02T11:00:00Z',
    updated_at: '2026-08-02T11:00:00Z'
  },
  {
    id: 1,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'first',
    reply_to: null,
    status: 'active',
    created_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z'
  },
  // A reply, and a reply to that reply — replies nest through the same column, so a thread is
  // the same read one level deeper.
  {
    id: 4,
    account_id: 2,
    handle: 'nightowl',
    display_name: 'Night Owl',
    body: 'congratulations on being first',
    reply_to: 1,
    status: 'active',
    created_at: '2026-08-02T10:05:00Z',
    updated_at: '2026-08-02T10:05:00Z'
  },
  {
    id: 5,
    account_id: 1,
    handle: 'ada',
    display_name: 'Ada',
    body: 'thank you',
    reply_to: 4,
    status: 'active',
    created_at: '2026-08-02T10:06:00Z',
    updated_at: '2026-08-02T10:06:00Z'
  }
];

const mockLikes: { blab_id: number; account_id: number }[] = [{ blab_id: 1, account_id: 2 }];

const mockDms: BlabberDm[] = [
  {
    id: 1,
    from_account: 2,
    to_account: 1,
    body: 'saw your post, funny stuff',
    read_at: null,
    status: 'active',
    created_at: '2026-08-02T12:30:00Z',
    updated_at: '2026-08-02T12:30:00Z'
  }
];

let nextDmId = 50;
let nextBlabId = 100;
let nextAccountId = 10;

/** Mirrors `gphone_max_accounts_per_app`'s default. The server is the boundary. */
const MOCK_ACCOUNT_LIMIT = 3;

const mockRegistry: Record<string, MockHandler> = {
  // Accounts. `limit` is the per-app cap the server reports from a convar — matched here
  // because a mock that omitted it would hide the Claim button in `pnpm dev` and show it
  // in game, or the reverse.
  getMyAccounts: () => ({
    rows: mockAccounts.filter((a) => a.app === 'blabber' && mockOwnedAccountIds.has(a.id)),
    limit: MOCK_ACCOUNT_LIMIT
  }),
  createAccount: ({ handle, display_name }: { handle: string; display_name?: string }) => {
    if (mockAccounts.some((a) => a.handle === handle)) throw new Error(`@${handle} is taken.`);
    if (mockOwnedAccountIds.size >= MOCK_ACCOUNT_LIMIT) {
      throw new Error(`You already hold ${MOCK_ACCOUNT_LIMIT} accounts here.`);
    }
    const created: Account = {
      id: nextAccountId++,
      app: 'blabber',
      handle,
      display_name: display_name ?? null,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockAccounts.push(created);
    mockOwnedAccountIds.add(created.id);
    return created;
  },
  /**
   * The generic owner-scoped update, which answers a bare boolean.
   *
   * `handle` and `app` are ignored rather than applied, because they are
   * `clientWritable: false` on the server and `ServiceEndpoint` drops them before SQL. A mock
   * that honoured them would let a rename look like it worked here and fail in game.
   */
  updateAccount: ({
    id,
    display_name,
    avatar,
    bio
  }: {
    id: number;
    display_name?: string | null;
    avatar?: string | null;
    bio?: string | null;
  }) => {
    // Owner-scoped, as the generic update is: a row id alone is never authorization (§2.9).
    const account = mockAccounts.find((a) => a.id === id && mockOwnedAccountIds.has(a.id));
    if (!account) return false;
    if (display_name !== undefined) account.display_name = display_name;
    if (avatar !== undefined) account.avatar = avatar;
    if (bio !== undefined) account.bio = bio;
    account.updated_at = new Date().toISOString();
    return true;
  },
  getAccounts: ({ handle, limit = 30 }: { handle?: string; limit?: number } = {}) => {
    const matches = mockAccounts.filter(
      (a) => a.app === 'blabber' && (handle === undefined || a.handle === handle)
    );
    return { rows: matches.slice(0, limit), nextCursor: null };
  },

  // Blabber DMs. 1:1, so a thread is the union of both directions between two accounts.
  getDmThreads: () => {
    const peers = new Map<number, (typeof mockDms)[number]>();
    for (const dm of [...mockDms].sort((a, b) => b.id - a.id)) {
      const peer = dm.from_account === 1 ? dm.to_account : dm.from_account;
      if (!peers.has(peer)) peers.set(peer, dm);
    }
    return [...peers.entries()].map(([peer_account_id, last]) => {
      const account = mockAccounts.find((a) => a.id === peer_account_id);
      return {
        peer_account_id,
        handle: account?.handle ?? null,
        display_name: account?.display_name ?? null,
        last,
        unread: mockDms.filter(
          (d) => d.to_account === 1 && d.from_account === peer_account_id && !d.read_at
        ).length
      };
    });
  },
  getDmMessages: ({ peer_account_id }: { peer_account_id: number }) => {
    const rows = mockDms
      .filter(
        (d) =>
          (d.from_account === 1 && d.to_account === peer_account_id) ||
          (d.from_account === peer_account_id && d.to_account === 1)
      )
      .sort((a, b) => b.id - a.id);
    return { rows, nextCursor: null };
  },
  sendDm: ({ peer_account_id, body }: { peer_account_id: number; body: string }) => {
    const created = {
      id: nextDmId++,
      from_account: 1,
      to_account: peer_account_id,
      body,
      read_at: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockDms.push(created);
    return created;
  },
  markDmRead: ({ peer_account_id }: { peer_account_id: number }) => {
    for (const dm of mockDms) {
      if (dm.to_account === 1 && dm.from_account === peer_account_id) {
        dm.read_at = new Date().toISOString();
      }
    }
    return true;
  },

  // Blabber. Keyset paging on `id DESC`, matching the server: a cursor names the last row
  // already delivered, and `nextCursor: null` means the end.
  getBlabs: ({
    cursor,
    limit = 30,
    reply_to
  }: { cursor?: number; limit?: number; reply_to?: number | null } = {}) => {
    // `reply_to: null` means top-level, matching the server's IS NULL. Honoured here or the
    // browser mock would show a feed the real server never returns.
    const matchesParent = (b: Blab) =>
      reply_to === undefined
        ? true
        : reply_to === null
          ? b.reply_to == null
          : b.reply_to === reply_to;
    const visible = mockBlabs
      .filter(
        (b) => b.status === 'active' && matchesParent(b) && (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  createBlab: ({ account_id, body, reply_to, mouth_of }: Partial<Blab>) => {
    // Ownership, not mere existence — this is `ownedAccount` on the server, and the message was
    // already claiming it while the check only asked whether the row existed at all.
    const account = mockAccounts.find((a) => a.id === account_id && mockOwnedAccountIds.has(a.id));
    if (!account) throw new Error('That account is not yours to post from.');
    const created: Blab = {
      id: nextBlabId++,
      account_id: account.id,
      // Hydrated exactly as the server's echo is, avatar and quoted Blab included. The client
      // prepends this row straight into the feed and no longer grafts the mouthed target on
      // itself, so a mock that omitted `mouthed` would render an empty quote card in the browser
      // while the real server rendered a full one — the mock disagreeing with the server is the
      // failure this file exists to avoid.
      handle: account.handle,
      display_name: account.display_name,
      avatar: account.avatar ?? null,
      body: body ?? null,
      reply_to: reply_to ?? null,
      mouth_of: mouth_of ?? null,
      mouthed:
        mouth_of == null
          ? null
          : (mockBlabs.find((b) => b.id === mouth_of && b.status === 'active') ?? null),
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockBlabs.unshift(created);
    return { ...created, editWindow: 900 };
  },
  updateBlab: ({ id, body }: { id: number; body: string }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.body = body;
    return true;
  },
  getBlabEngagement: ({ ids = [] }: { ids?: number[] } = {}) => {
    const out: Record<number, unknown> = {};
    for (const id of ids) {
      out[id] = {
        replies: mockBlabs.filter((b) => b.reply_to === id && b.status === 'active').length,
        mouths: mockBlabs.filter((b) => b.mouth_of === id && b.status === 'active').length,
        likes: mockLikes.filter((l) => l.blab_id === id).length,
        likedByMe: mockLikes.some((l) => l.blab_id === id && l.account_id === 1),
        mouthedByMe: mockBlabs.some(
          (b) => b.mouth_of === id && b.account_id === 1 && b.status === 'active'
        )
      };
    }
    return out;
  },
  likeBlab: ({ blab_id }: { blab_id: number }) => {
    if (!mockLikes.some((l) => l.blab_id === blab_id && l.account_id === 1)) {
      mockLikes.push({ blab_id, account_id: 1 });
    }
    return true;
  },
  unlikeBlab: ({ blab_id }: { blab_id: number }) => {
    const at = mockLikes.findIndex((l) => l.blab_id === blab_id && l.account_id === 1);
    if (at >= 0) mockLikes.splice(at, 1);
    return true;
  },
  getProfileBlabs: ({
    account_id,
    tab,
    cursor,
    limit = 30
  }: {
    account_id: number;
    tab?: string;
    cursor?: number;
    limit?: number;
  }) => {
    const repliesOnly = tab === 'replies';
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.account_id === account_id &&
          (repliesOnly ? b.reply_to != null : b.reply_to == null) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  deleteBlab: ({ id }: { id: number }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.status = 'deleted';
    return true;
  },

  // Contacts
  ...defineMockCrud<Contact>(mockContacts, {
    list: 'getContacts',
    create: 'createContact',
    update: 'updateContact',
    remove: 'deleteContact'
  }),
  // Matches the client exactly. A mock that succeeded where the game fails is how the
  // stub survived this long.
  shareContact: async () => ({ error: 'Sharing a contact is not implemented yet' }),

  // Notes
  ...defineMockCrud<Note>(mockNotes, {
    list: 'getNotes',
    create: 'createNote',
    update: 'updateNote',
    remove: 'deleteNote'
  }),

  // Messages
  getConversations: () => mockConversations,
  getMessages: ({ conversation_id }: { conversation_id: number }) => {
    return mockMessages[conversation_id] || [];
  },
  receiveMessage: async (payload: any) => {
    const convId = payload.conversation_id || 1;
    const msgText = payload.message || '1... 🤬😡🗯️‼️';
    const conv = mockConversations.find((c) => c.id === convId);
    if (conv) {
      conv.unread_count = (conv.unread_count || 0) + 1;
      const newMsg: Message = {
        id: Math.floor(Math.random() * 1000000),
        conversation_id: convId,
        citizenid: (conv as any).cit || 'cit-ursula',
        status: 'active',
        message: msgText,
        attachments: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      conv.last_message = newMsg;
      if (!mockMessages[convId]) mockMessages[convId] = [];
      mockMessages[convId].push(newMsg);
    }
    return true;
  },
  sendMessage: async (payload: any) => {
    await delay(200);
    const convId = payload.conversation_id;
    const msg: Message = {
      id: Math.floor(Math.random() * 1000000),
      conversation_id: convId,
      citizenid: 'my-id',
      status: 'active',
      message: payload.message,
      attachments: (payload.attachments || []).map((a: any, i: number) => ({ ...a, id: i })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (!mockMessages[convId]) {
      mockMessages[convId] = [];
    }
    mockMessages[convId].push(msg);

    const conv = mockConversations.find((c) => c.id === convId);
    if (conv) {
      conv.last_message = msg;
      conv.updated_at = msg.created_at;
    }

    return msg;
  },
  startConversation: async ({ phone, is_group }: any) => {
    await delay(300);
    return {
      id: Math.random(),
      citizenid: 'my-id',
      is_group: is_group || false,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: []
    } as Conversation;
  },
  readConversation: async (data: any) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.unread_count = 0;
      const myPart = conv.participants?.find((p) => p.citizenid === 'my-id');
      if (myPart && conv.last_message) {
        myPart.last_read = conv.last_message.created_at;
      }
    }
    return true;
  },
  archiveConversation: async (data: any) => {
    await delay(200);
    // Reads `status`, which is what `store/messages.ts` actually sends. It used to read
    // `archived`, a key nothing ever set, so archiving was a silent no-op in the browser
    // and in Playwright — the route test only checks names, not payloads.
    const conv = mockConversations.find((c) => c.id === data?.conversation_id);
    if (conv && (data?.status === 'archived' || data?.status === 'active')) {
      conv.status = data.status;
    }
    return true;
  },
  deleteConversation: async (data: any) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const idx = mockConversations.findIndex((c) => c.id === id);
    if (idx !== -1) {
      mockConversations.splice(idx, 1);
    }
    return true;
  },
  renameConversation: async (data: any) => {
    await delay(200);
    const id = data?.id ?? data?.conversation_id;
    const name = data?.name;
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.name = name;
    }
    return { success: true, name };
  },

  // Account
  getCitizenId: () => 'my-id',
  getPhoneNumber: () => '867-5309',
  getBankBalance: () => 12450,
  // Shaped exactly like BankingBridge output: positive magnitudes with an explicit
  // direction. The previous mock used signed amounts, which no banking resource
  // produces — so red/green rendering worked here and was wrong in game.
  getTransactions: (): Transaction[] => [
    {
      id: 'mock-1',
      title: 'Store',
      message: 'Store Purchase',
      amount: 45,
      direction: 'out',
      time: Math.floor(Date.now() / 1000)
    },
    {
      id: 'mock-2',
      title: 'Job',
      message: 'Salary',
      amount: 1500,
      direction: 'in',
      time: Math.floor(Date.now() / 1000) - 86400
    },
    {
      id: 'mock-3',
      title: 'Transfer',
      message: 'Transfer',
      amount: 200,
      direction: 'out',
      time: Math.floor(Date.now() / 1000) - 172800
    }
  ],

  // Call
  startCall: async () => {
    await delay(1000);
    return true;
  },
  endCall: async () => {
    return true;
  },
  answerCall: async () => {
    return true;
  },
  toggleMute: async () => {
    return true;
  },
  toggleSpeaker: async () => {
    return true;
  },

  // Camera & Photos
  takePhoto: () => {
    const photo = sampleAvatars[mockPhotoIndex % sampleAvatars.length];
    mockPhotoIndex++;
    return photo;
  },
  flipCamera: async (data: any) => ({ supported: true, isFrontCamera: !!data?.isFrontCamera }),
  onCameraApp: async () => true,
  // Photos and mail are soft-deleted, as the server does it: a removed row is still
  // there to be moderated.
  ...defineMockCrud<Photo>(
    mockPhotos,
    { list: 'getPhotos', create: 'createPhoto', remove: 'deletePhoto' },
    {
      remove: 'soft',
      visible: (p) => p.status !== 'deleted',
      insert: 'prepend',
      defaults: { status: 'active' }
    }
  ),

  // Mail
  ...defineMockCrud<Mail>(
    mockEmails,
    { list: 'getMail', remove: 'deleteMail' },
    { remove: 'soft', visible: (e) => e.status !== 'deleted' }
  ),
  markAsRead: async (data: { id: number }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.read = true;
    return true;
  },
  archiveMail: async (data: { id: number; archive?: boolean }) => {
    const item = mockEmails.find((e) => e.id === data.id);
    if (item) item.status = data.archive === false ? 'active' : 'archived';
    return true;
  },

  // Reports & moderation. Stateful, like the photo and mail mocks: resolving has to
  // actually empty the queue, or the browser cannot show what happens next and the undo
  // flow has nothing to undo.
  createReport: async () => ({ ok: true, id: 1 }),
  getReportQueue: async () => mockReports.filter((r) => r.resolution === 'pending'),
  getReportHistory: async () => mockReports.filter((r) => r.resolution !== 'pending'),
  resolveReport: async (data: any) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = data?.action === 'moderate' ? 'actioned' : 'dismissed';
    return { ok: true, resolution: report?.resolution };
  },
  reopenReport: async (data: any) => {
    const report = mockReports.find((r) => r.id === data?.id);
    if (report) report.resolution = 'pending';
    return { ok: true, resolution: 'pending' };
  },

  // Navigation & Client Controls
  hideFrame: () => true,
  toggleFreelook: () => true,
  rejectCall: () => true,
  setTyping: () => true,
  setBatteryLevel: () => true,
  // The browser has no ace list; the panel is unconditional there anyway.
  checkAdmin: () => ({ isAdmin: true })
};

async function getMockData(eventName: string, data?: any): Promise<any> {
  const handler = mockRegistry[eventName];
  if (handler) {
    return handler(data);
  }
  console.warn(`[MockRegistry] No handler found for event: ${eventName}`);
  return null;
}

export const MockRegistry = {
  has: (eventName: string) => Boolean(mockRegistry[eventName]),
  handle: (eventName: string, data?: any) => getMockData(eventName, data)
};
