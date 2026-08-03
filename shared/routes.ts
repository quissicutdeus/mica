import { requestEventFor } from './rpc';

/**
 * Every NUI action that forwards to the server, declared once.
 *
 * Replaces seven near-identical client relay files whose entire
 * content was `app.registerCallback(nuiAction, serverEvent)` repeated. Those files were
 * data pretending to be code, and being spread across seven files is what let routes go
 * missing without anyone noticing.
 *
 * The point is not the line count. It is that a single table can be **checked**:
 * `server/__tests__/routes.test.ts` cross-references it against the `fetchNui` calls in
 * `web/`, the events the server actually registers, and the browser mock registry. A
 * missing layer is the most common bug in this codebase — `readConversation`,
 * `renameConversation`, `archiveConversation`, `rejectCall`, `flipCamera` and all four
 * mail actions have each shipped as a silent no-op — and the mock registry makes every
 * one of them invisible in `pnpm dev` and in Playwright.
 */
export interface Route {
  /** The name `fetchNui` is called with from `web/`. */
  action: string;
  /** The owning service; the second segment of the server event. */
  service: string;
  /** The action segment of the server event. Often differs from the NUI name. */
  serverAction: string;
}

const route = (action: string, service: string, serverAction: string): Route => ({
  action,
  service,
  serverAction
});

export const ROUTES: readonly Route[] = [
  // Admin
  route('checkAdmin', 'admin', 'check'),

  // Bank — read-only, backed by the banking resource's export rather than a table.
  route('getTransactions', 'bank', 'getTransactions'),

  // Accounts — social identities, shared by every social app. `mine` is a custom action
  // scoped server-side; making citizenid client-filterable would let anyone list anyone's.
  route('getMyAccounts', 'accounts', 'mine'),
  route('createAccount', 'accounts', 'create'),
  // Public handle lookup, paged. Used by a profile page to resolve @handle -> account.
  route('getAccounts', 'accounts', 'get'),

  // Blabber. `getBlabs` is a public paged read: `{ cursor, limit }` in,
  // `{ rows, nextCursor }` out.
  route('getBlabs', 'blabber', 'get'),
  route('createBlab', 'blabber', 'create'),
  route('updateBlab', 'blabber', 'update'),
  route('deleteBlab', 'blabber', 'delete'),
  // One account's public profile, split into Blabs and Replies.
  route('getProfileBlabs', 'blabber', 'profile'),
  // Reply, mouth and like counts for a page of Blabs, batched — one read rather than three
  // per row.
  route('getBlabEngagement', 'blabber', 'engagement'),
  route('likeBlab', 'blabber', 'like'),
  route('unlikeBlab', 'blabber', 'unlike'),

  // Contacts
  route('getContacts', 'contacts', 'get'),
  route('createContact', 'contacts', 'create'),
  route('updateContact', 'contacts', 'update'),
  route('deleteContact', 'contacts', 'delete'),

  // Conversations
  route('getConversations', 'conversations', 'get'),
  route('startConversation', 'conversations', 'create'),
  // The handler decides between an admin soft-delete and a participant leaving, based
  // on who is asking, so there is one route rather than two. A separate
  // `leaveConversation` route existed and `web/` never called it.
  route('deleteConversation', 'conversations', 'delete'),
  route('readConversation', 'conversations', 'read'),
  route('archiveConversation', 'conversations', 'archive'),
  // Rename rides the generic update: `clientWritable` on the conversations repo is
  // ['name'], and `update` is ownership-scoped, so only the creator can rename.
  route('renameConversation', 'conversations', 'update'),

  // Mail
  route('getMail', 'mail', 'getMail'),
  route('markAsRead', 'mail', 'markAsRead'),
  route('archiveMail', 'mail', 'archiveMail'),
  route('deleteMail', 'mail', 'deleteMail'),

  // Messages
  route('getMessages', 'messages', 'get'),
  route('sendMessage', 'messages', 'send'),

  // Notes
  route('getNotes', 'notes', 'get'),
  route('createNote', 'notes', 'create'),
  route('updateNote', 'notes', 'update'),
  route('deleteNote', 'notes', 'delete'),

  // Reports. `queue` and `resolve` are admin-only, enforced server-side rather than by
  // hiding the Administration app — hiding the app hides the button, not the capability.
  route('createReport', 'reports', 'create'),
  route('getReportQueue', 'reports', 'queue'),
  route('resolveReport', 'reports', 'resolve'),
  route('getReportHistory', 'reports', 'history'),
  route('reopenReport', 'reports', 'reopen'),

  // Photos — no `updatePhoto`: a stored photo has no mutable fields, and the server
  // does not register the endpoint.
  route('getPhotos', 'photos', 'get'),
  route('createPhoto', 'photos', 'create'),
  route('deletePhoto', 'photos', 'delete')
] as const;

/** The `gphone:server:<app>:<action>` event a route forwards to. */
export const serverEventFor = (r: Route): string => requestEventFor(r.service, r.serverAction);

/**
 * NUI actions handled entirely on the client, with no server round trip.
 *
 * Declared so the completeness test can tell "handled somewhere else" apart from
 * "nobody wired this up". Anything `web/` calls that is in neither list is a bug.
 */
export const CLIENT_ONLY_ACTIONS: readonly string[] = [
  // Phone shell
  'hideFrame',
  'toggleFreelook',
  'setTyping',
  'onCameraApp',
  // Calls — fire-and-forget, no cbId to correlate and no reply to await.
  'startCall',
  'answerCall',
  'endCall',
  'rejectCall',
  'toggleSpeaker',
  'toggleMute',
  // Hardware and framework reads
  'getBankBalance',
  'getCitizenId',
  'getPhoneNumber',
  'setBatteryLevel',
  'takePhoto',
  // Front/rear toggle on the scripted camera.
  'flipCamera'
] as const;

/**
 * Actions `web/` may call that are deliberately unimplemented in game.
 *
 * An entry here is a promise that the **web** handles the missing capability visibly —
 * not a place to park a silent no-op. The test enforces that the callback still answers,
 * because an absent one is the silent no-op this whole table exists to outlaw.
 *
 * `flipCamera` lived here until the scripted camera made it real.
 */
export const UNIMPLEMENTED_ACTIONS: readonly string[] = [
  // Proximity share. The client callback is a stub that logs and returns success, so
  // the phone announced "Contact shared successfully" and nothing left the machine —
  // the same lie `alert('Photos shared! (Mock)')` used to tell, hidden one layer deeper.
  // It was listed as client-only, which satisfied every check: the callback really is
  // registered, and no test can see that the body does nothing.
  'shareContact'
] as const;
