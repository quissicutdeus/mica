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

  // Bank — read-only history backed by the banking resource's export rather than a table,
  // plus one write: a player-to-player transfer resolved by phone number server-side.
  route('getTransactions', 'bank', 'getTransactions'),
  route('sendMoney', 'bank', 'sendMoney'),

  // Accounts — social identities, shared by every social app. `mine` is a custom action
  // scoped server-side; making citizenid client-filterable would let anyone list anyone's.
  route('getMyAccounts', 'accounts', 'mine'),
  route('createAccount', 'accounts', 'create'),
  // Editing the display half of an identity — `display_name`, `avatar`, `bio`. The generic
  // owner-scoped update, which is safe to expose because `app` and `handle` are
  // `clientWritable: false`: a renamed handle would break every mention of it.
  route('updateAccount', 'accounts', 'update'),
  // Public handle lookup, paged. Used by a profile page to resolve @handle -> account.
  route('getAccounts', 'accounts', 'get'),
  // The follow graph, shared by every social app rather than owned by Blabber. Counts are read
  // rather than denormalised onto the account row, which would be a second copy free to drift.
  route('followAccount', 'accounts', 'follow'),
  route('unfollowAccount', 'accounts', 'unfollow'),
  route('getFollowStats', 'accounts', 'follows'),
  // The two lists behind those counts, each keyset paged on the follow row's own id so the order
  // is most-recently-followed first. Public, like the counts: they answer a question about a
  // stranger's profile, not about the caller. Read by an add-on through the `accounts` *facet*
  // (`useAccounts().getFollowers`), never by calling this action from inside the sandbox.
  route('getFollowers', 'accounts', 'followers'),
  route('getFollowing', 'accounts', 'following'),
  // Handle / display-name search within one app, keyset paged. On `accounts` rather than on a
  // social app's own service for the same reason the follow lists are: identity is shared, so a
  // second social app gets this search for free. Read from an add-on through the `accounts`
  // facet (`useAccounts().searchAccounts`) — Blabber's Search > People segment — never by naming
  // this action from inside the sandbox.
  route('searchAccounts', 'accounts', 'search'),
  // The block graph, alongside the follow one. One-directional: it hides the blocked account
  // from the blocker's own feeds and notifications and refuses a DM between the two, and does
  // not tell the blocked account anything happened.
  route('blockAccount', 'accounts', 'block'),
  route('unblockAccount', 'accounts', 'unblock'),
  // Reactions, on any table that opted in via `defineService`'s `reactable`. Shared by every
  // social app for the same reason follows and blocks are.
  route('reactToTarget', 'accounts', 'react'),
  route('unreactToTarget', 'accounts', 'unreact'),
  route('getReactionsFor', 'accounts', 'reactionsFor'),

  // Contacts
  route('getContacts', 'contacts', 'get'),
  route('getCallLog', 'phone_call_log', 'get'),
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

  // Messages. All four are custom actions: `access.write: 'members'` registers no generic
  // CRUD at all, because a membership check needs the parent conversation id and that is
  // not part of the generic payload contract.
  route('getMessages', 'messages', 'get'),
  route('sendMessage', 'messages', 'send'),
  // Fix or take back one message you sent. `editMessage` rewrites the body and the thread
  // marks the result as edited; `deleteMessage` is an **unsend** — a soft delete that
  // removes the message from every participant's thread, not a hide-for-me.
  route('editMessage', 'messages', 'edit'),
  route('deleteMessage', 'messages', 'delete'),
  // Reactions (MICA-143), on the shared client-side primitive (`createReactionStore`/
  // `ReactionBar`, MICA-98) but a `messages`-owned table rather than the shared
  // `gphone_account_reactions` — see `Messages.ts`'s docblock above `requireReactableMessage`
  // for why. Named distinctly from `accounts`' `reactToTarget`/`unreactToTarget`/
  // `getReactionsFor` even though the shape is identical, since `action` is the NUI name and
  // must be globally unique across every service's routes.
  route('reactToMessage', 'messages', 'react'),
  route('unreactToMessage', 'messages', 'unreact'),
  route('getMessageReactions', 'messages', 'reactionsFor'),

  // Notes
  // Notes is `core: false` and reaches its service through the generic route instead, so
  // it needs no row here. That is the whole point of the generic route: this table ships
  // inside gPhone, and an app installed from the Store cannot add to it.

  // Reports. `queue` and `resolve` are admin-only, enforced server-side rather than by
  // hiding the Administration app — hiding the app hides the button, not the capability.
  route('createReport', 'reports', 'create'),
  route('getReportQueue', 'reports', 'queue'),
  route('resolveReport', 'reports', 'resolve'),
  route('getReportHistory', 'reports', 'history'),
  route('reopenReport', 'reports', 'reopen'),

  // Highscores — shared leaderboard table, one row per (citizenid, app). Core, not
  // owned by any one game, so a future game reuses it instead of shipping its own table.
  route('submitHighscore', 'highscores', 'submit'),
  route('getHighscoreLeaderboard', 'highscores', 'top'),

  // Media — no `updateMedia`: a stored row has no mutable fields, and the server does
  // not register the endpoint.
  route('getMedia', 'media', 'get'),
  // One row, `data` and all. The list read is projected down to `thumbnail` plus metadata
  // (MICA-110), so the bytes are asked for by id when a photo is opened — and by anything
  // that needs the original rather than a tile, such as picking an avatar or a wallpaper.
  route('getMediaItem', 'media', 'item'),
  // Store-back for a row that arrived without a thumbnail — `AddMedia`'s `thumbnail` is
  // optional, so other resources keep creating them. The client encodes one from the bytes
  // it just fetched and hands it back, so the next open does not repeat the work. Named,
  // ownership-scoped and write-once on the server; `thumbnail` stays `clientWritable: false`
  // and this is not the generic write path.
  route('setMediaThumbnail', 'media', 'thumbnail'),
  route('createMedia', 'media', 'create'),
  route('deleteMedia', 'media', 'delete'),
  // Bluetooth proximity: copy a media row the caller owns to everyone nearby and visible.
  route('shareMediaNearby', 'media', 'drop'),
  // Location sharing. Not a dumb passthrough — its client relay in `client/services/
  // Location.ts` resolves a street-name label locally (a client-only native) before
  // forwarding, so it is excluded from `Relay.ts`'s generic per-route registration.
  // Declared here anyway, for `routes.test.ts`'s completeness checks.
  route('shareLocation', 'media', 'shareLocation'),

  // Music — proximity broadcast (MICA-111 phase 2). The service holds ephemeral
  // now-playing state and nothing else: no table, no generic CRUD, and every action here is
  // about the caller's own phone. What other people hear comes back the other way, on the
  // shell-scoped push in `shared/musicBroadcast.ts`, rather than as a reply to any of these.
  route('startMusicBroadcast', 'music', 'broadcastStart'),
  // Pause, resume and seek. Separate from the start above because a track change is a
  // replacement and these are not; folding them together would make "paused" a field a
  // caller had to restate every time it named a track.
  route('updateMusicBroadcast', 'music', 'broadcastUpdate'),
  route('stopMusicBroadcast', 'music', 'broadcastStop'),

  // Lock screen passcode (MICA-60) — display state, not a security boundary (the
  // ticket's own item 4): nothing behind the lock is authority-bearing, so a modified
  // client that answers its own `checkPasscode` gains nothing it did not already have.
  // The passcode itself never touches `settings`/`useStorage` — only this dedicated,
  // presumably-hashed service does.
  //
  // PENDING (Cody): no `registerEvent` handler exists for any of these four yet —
  // `web/src/nui/mocks/registry.ts` is what answers them today.
  route('getPasscodeStatus', 'lockscreen', 'status'),
  route('setPasscode', 'lockscreen', 'set'),
  route('checkPasscode', 'lockscreen', 'check'),
  route('clearPasscode', 'lockscreen', 'clear'),

  // Notifications — persistent OS notification service
  route('getShadeNotifications', 'notifications', 'getShadeNotifications'),
  route('getNotificationHistory', 'notifications', 'getNotificationHistory'),
  route('getUnreadCounts', 'notifications', 'getUnreadCounts'),
  route('markNotificationRead', 'notifications', 'markAsRead'),
  route('clearNotifications', 'notifications', 'clearNotifications'),
  route('clearAllNotifications', 'notifications', 'clearAllNotifications'),
  route('restoreNotifications', 'notifications', 'restoreNotifications'),

  // Settings — every stored preference, owned by a citizenid rather than a browser
  // profile. Not an app: `settings` is a service the shell reads on behalf of every
  // `useStorage` namespace, the Settings app included.
  route('getSettings', 'settings', 'getAll'),
  route('saveSetting', 'settings', 'set'),
  route('removeSetting', 'settings', 'remove'),
  route('clearAppSettings', 'settings', 'clearApp')
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
  // DevTools' in-game "Simulate Incoming Call" — same fire-and-forget shape.
  'simulateIncomingCall',
  // Proximity contact sharing — same fire-and-forget shape as a call. The outcome is
  // pushed back as a toast rather than returned on this reply.
  'shareContact',
  // Hardware and framework reads
  'getBankBalance',
  'getCitizenId',
  'getPhoneNumber',
  'setBatteryLevel',
  'takePhoto',
  // Front/rear toggle on the scripted camera.
  'flipCamera',
  // `gphone_camera_quality`. The NUI cannot read a convar, so the client reads it and
  // answers with it — a hardware read like the four above, not a service call.
  'cameraQuality',
  // `gphone_addon_hosts` and `gphone_addon_catalog`, the same way and for the same reason
  // (MICA-126). Asked once at page load, before the registry re-verifies saved remote
  // installs — the allowlist has to be in place before that check can mean anything.
  'remoteAppConfig',
  // Setting a GPS waypoint from a location a message already carries is purely local —
  // `SetNewWaypoint` fires on the recipient's own client with no server round trip.
  'setWaypoint'
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
/**
 * Deliberately empty.
 *
 * `shareContact` used to be the one entry — a stub that logged and returned success, so
 * the phone announced "Contact shared successfully" and nothing left the machine. It is
 * now real (`CLIENT_ONLY_ACTIONS` above) and this list is what stays empty until the next
 * feature ships ahead of its wiring.
 */
export const UNIMPLEMENTED_ACTIONS: readonly string[] = [] as const;
