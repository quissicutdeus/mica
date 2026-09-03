// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
  // Accounts — social identities, shared by every social app. Every custom action here is
  // declared in `shared/contracts/accounts.ts` and reached by the typed `call`, so the two
  // rows left are the generic ones.
  // Editing the display half of an identity — `display_name`, `avatar`, `bio`. The generic
  // owner-scoped update, which is safe to expose because `app` and `handle` are
  // `clientWritable: false`: a renamed handle would break every mention of it.
  route('updateAccount', 'accounts', 'update'),
  // Public handle lookup, paged. Used by a profile page to resolve @handle -> account.
  route('getAccounts', 'accounts', 'get'),
  // Contacts
  route('getContacts', 'contacts', 'get'),
  route('getCallLog', 'phone_call_log', 'get'),
  route('createContact', 'contacts', 'create'),
  route('updateContact', 'contacts', 'update'),
  route('deleteContact', 'contacts', 'delete'),
  // Conversations. `get`, `create`, `read`, `archive` and `delete` are contracted, so
  // `web/` reaches them with the typed `call` over the generic service action and they
  // need no row here (MICA-213).
  //
  // Rename rides the generic update: `clientWritable` on the conversations repo is
  // ['name'], and `update` is ownership-scoped, so only the creator can rename. It is not
  // in the contract, so it keeps its row.
  route('renameConversation', 'conversations', 'update'),

  // Mail

  // Messages. Every action is custom — `access.write: 'members'` registers no generic CRUD
  // at all, because a membership check needs the parent conversation id and that is not
  // part of the generic payload contract — and all seven are contracted, so `web/` reaches
  // them through the typed `call` and none needs a row here (MICA-213).

  // Notes
  // Notes is `core: false` and reaches its service through the generic route instead, so
  // it needs no row here. That is the whole point of the generic route: this table ships
  // inside gOS, and an app installed from the Store cannot add to it.

  // Reports. `queue` and `resolve` are admin-only, enforced server-side rather than by
  // hiding the Administration app — hiding the app hides the button, not the capability.
  // All five are contracted and reached with the typed `call` (MICA-213).

  // Media — no `updateMedia`: a stored row has no mutable fields, and the server does
  // not register the endpoint.
  route('getMedia', 'media', 'get'),
  route('createMedia', 'media', 'create'),
  route('deleteMedia', 'media', 'delete')
  // The rest of `media` is contracted, so it needs no row here (MICA-213): `item`,
  // `thumbnail`, `getDeleted`, `restore`, `drop` and `shareLocation` are reached by the
  // typed `call(mediaContract, …)` over the generic service action, which the relay
  // subscribes per request. Only the three generic CRUD actions above, whose shape comes
  // from the column declaration rather than from a contract, are still named here.

  // Music — proximity broadcast (MICA-111 phase 2). The service holds ephemeral
  // now-playing state and nothing else: no table, no generic CRUD, and every action is
  // about the caller's own phone. What other people hear comes back the other way, on the
  // shell-scoped push in `shared/musicBroadcast.ts`, rather than as a reply to any of them.
  // All three are contracted (`shared/contracts/music.ts`) and reached by the typed call,
  // so `music` has no rows here at all.

  // Notifications — persistent OS notification service. All seven are contracted and
  // reached with the typed `call` (MICA-213).

  // Places (MICA-65) rides the generic service action through `createCrudStore`'s
  // `service` option, so it has no rows here (MICA-213).

  // Settings — every stored preference, owned by a citizenid rather than a browser
  // profile. Not an app: `settings` is a service the shell reads on behalf of every
  // `useStorage` namespace, the Settings app included. All four of its actions are
  // contracted (`shared/contracts/settings.ts`) and reached by the typed call
  // (MICA-213), so the service keeps no rows here; `web/src/services/settings.ts` is
  // the caller and `sdk/host/settingsSync.ts` is what drives it.
] as const;

/** The `gos:server:<app>:<action>` event a route forwards to. */
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
  // `gos_camera_quality`. The NUI cannot read a convar, so the client reads it and
  // answers with it — a hardware read like the four above, not a service call.
  'cameraQuality',
  // `gos_addon_hosts` and `gos_addon_catalog`, the same way and for the same reason
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
