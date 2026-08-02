import {
  mockContacts,
  mockConversations,
  mockEmails,
  mockMessages,
  mockNotes,
  mockPhotos,
  sampleAvatars
} from './data';
import type { Contact, Conversation, Mail, Message, Note, Photo, Transaction } from '@shared/types';
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

const mockRegistry: Record<string, MockHandler> = {
  // Contacts
  ...defineMockCrud<Contact>(mockContacts, {
    list: 'getContacts',
    create: 'createContact',
    update: 'updateContact',
    remove: 'deleteContact'
  }),
  shareContact: async () => true,

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
