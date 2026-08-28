# Does the Music embed work in CEF? The procedure that settles it

MICA-111 phase 1 exists to answer one question, and no test suite can answer
it: **does a cross-origin YouTube iframe, driven by `postMessage`, work inside
FiveM's CEF?** `pnpm test:e2e` drives a modern Chromium against a stub
(`web/e2e/apps/music.spec.ts`), the unit tests drive jsdom, and neither has ever
loaded a player. This file is the procedure that does, at an F8 console, in
game.

Read [`docs/cef-baseline.md`](cef-baseline.md) first if you have not. This one
depends on it and does not repeat it.

## The short version, before you spend an evening on it

**Nothing in the Chromium 103 baseline forbids this approach.** Every capability
the embed needs — sandboxed iframes, the `allow` attribute and its JS API,
`postMessage`, MSE, WebM, Web Audio — is supported well below the floor, checked
against this repo's own `caniuse-lite@1.0.30001809`:

| Capability                                | First full Chrome | At 103      |
| ----------------------------------------- | ----------------- | ----------- |
| `iframe` `sandbox`                        | 5                 | yes         |
| Feature Policy (`allow`, `featurePolicy`) | 74                | yes         |
| Permissions Policy (the newer spec)       | —                 | **partial** |
| Media Source Extensions                   | 31                | yes         |
| WebM                                      | 25                | yes         |
| Web Audio                                 | 34                | yes         |

So "wait for the M140/M144 CEF upgrade" is **not** a plan for this feature, in
exactly the way `cef-baseline.md` concludes it is not a plan for `<video>`.
Every remaining risk is a property of the FiveM client — what it allows the NUI
page to load, what it delegates to it, and what autoplay policy it launches with
— not a property of the Chromium version. An upgrade changes none of those on
its own.

The one line worth carrying into the check list: **Permissions Policy is partial
at 103, Feature Policy is not.** Use `document.featurePolicy`, not
`document.permissionsPolicy`, or your check returns `undefined` and reads as a
failure that isn't one.

### What the baseline does say about this feature

Two entries bear on it, one directly:

- **"Backgrounded add-on iframes use `visibility:hidden`, not `display:none`"**
  — observed in game, in CEF 103: a `display:none` iframe collapsed to a 0x0
  viewport and CEF did not reliably lay it back out, so the add-on came back
  blank while still running. That is independent, in-game corroboration of why
  `MusicPlayer.svelte` lays the player out at 200x200 and hides it with
  `opacity-0` rather than `display:none`. An invisible iframe invites exactly
  that tidy-up, and `display:none` is the first thing anyone reaches for — so:
  do not, while debugging or afterwards. You would be reproducing a known CEF
  103 bug on purpose, and the symptom (a frame that is alive but blank, or a
  player that stops when it should not) looks nothing like its cause.
- **"Eager `AudioContext` warm/unlock"** (`shell/state/audio.ts`) is listed as
  autoplay-policy-driven and _not_ version-gated, which is correct — but it does
  **not** transfer to the embed, and it is worth being precise about why. The
  context it warms is in the shell's own document; the embed's audio is a media
  element inside a document at another origin that we cannot reach into.
  `resume()` on our context does nothing for it, and user activation does not
  cross into a cross-origin child (the HTML spec propagates activation to
  descendants only where they are same-origin), so the phone cannot "unlock" the
  frame on a click the way it unlocks its own sounds.

  What _is_ transferable is the inference in that file's comment: `warm()` only
  attempts an eager resume in CEF because in a plain browser it always fails.
  That reads as evidence the FiveM client launches CEF with a permissive
  autoplay policy. It is an inference from a comment, not a measurement, and Web
  Audio, media-element autoplay and the `autoplay` Permissions Policy are three
  separate gates. Check 6 below measures the third one, which nobody has
  measured.

### Does the repo already answer "can CEF load a third-party frame"?

No, and it is worth knowing what the near misses are so nobody mistakes one for
an answer:

- **Add-on iframes** (`shell/addon/AddOnFrame.svelte`) are `srcdoc` with an
  opaque origin. Nothing is fetched, so they prove nothing about network
  documents.
- **`installVerified`** (`shell/state/registry.ts`) does `fetch()` a remote
  bundle over https from the NUI page — but the trusted-host allowlist is empty
  by default, so there is no evidence anyone has ever run it in game.
- **Remote `https:` images render in game** through `MediaThumb`'s `SAFE_SRC`
  path (`cef-baseline.md` says so). That is real evidence the client's network
  stack is reachable from the page, and it is the strongest thing the repo has —
  but an image is a subresource, and a frame is a navigation of a nested
  browsing context. They are not the same permission.

## A refusal is a _result_, not a dead end

`MusicPlayer.svelte` reads the player's `onError` frames and puts the phone into
`musicStatus: 'error'` with a reason and the raw code
(`web/src/lib/musicErrors.ts`):

| On screen                          | Reason          | Codes      |
| ---------------------------------- | --------------- | ---------- |
| "Can't be played outside YouTube"  | `embed-blocked` | 101, 150   |
| "Unavailable — removed or private" | `unavailable`   | 100        |
| "Can't be played"                  | `unplayable`    | 2, 5, else |

Read those as **good news about CEF**, because every one of them is proof of the
things checks 1 and 3 are asking about: to say any of it, the frame must have
loaded, the player must have run, and its message must have crossed back over
`postMessage` to us. So if the screen says "Can't be played outside YouTube",
stop worrying about the client — that is one uploader ticking a box, not your
answer. Try another video and carry on down the list.

This used to be the opposite: an embedding-disabled video left the phone on
"Starting…" forever, which is **indistinguishable from CEF refusing the frame**
and made the whole procedure ambiguous. It is distinguishable now.

**The one case that stays ambiguous is a hang, and only a hang.** The error
frames ride the same `postMessage` channel as everything else, so a CEF that
answers nothing at all reports no error either — an unembeddable video and a
refused frame both sit on "Starting…". An indefinite "Starting…" is therefore
still a check-3 question and never an answer on its own. What has changed is
that it is now the _only_ remaining ambiguous outcome rather than a state any
ordinary video could land you in.

Report the code, not just the phrase. "It did not play" and "it reported 150"
are different bug reports and only one of them can be acted on.

## Setup

1. Developer mode on, and the resource running.
2. F8 console: `nui_devTools`. (Or `http://localhost:13172/` in a desktop
   browser while the game runs — same DevTools, easier to type into.)
3. In DevTools, use the **JavaScript context selector** to select the gPhone
   frame — `https://cfx-nui-gphone`. Everything below runs in **that** context,
   not in the top `nui://game` one.
4. Open the phone, open Music, and keep the **Network** panel recording.

Paste this once, before anything else; several checks reuse `f`:

```js
const f = () => document.querySelector('iframe[title="gPhone music player"]');
```

## Check 0 — where you actually are

```js
location.origin; // expect "https://cfx-nui-gphone"
window.top === window; // false means the phone is a nested frame
```

`shell/nuiGuard.ts` assumes the phone is a frame inside a root `nui://game`
window, and accepts `event.source === window.top` on that basis. It also accepts
`event.source === window`, so if the two are the same object the guard's comment
has never actually been distinguished from the alternative. Write down which
answer you get: everything about Permissions Policy delegation below depends on
whether there is a parent frame that had to delegate anything.

## Check 1 — does the request leave the client?

With the Network panel recording, paste a link into Music and press Play. Look
for a **Doc** request to `https://www.youtube-nocookie.com/embed/<id>?…`.

- **No request at all** — the client blocked the navigation before the network.
  Isolate whether it is YouTube or any external document:

  ```js
  const t = document.createElement('iframe');
  t.src = 'https://example.com/';
  document.body.append(t);
  // then look at the Network panel again, and remove it: t.remove()
  ```

  If that request is absent too, CEF is refusing third-party frames outright and
  this approach is dead as designed — see "If it cannot work" below.

- **Request present, network error** — the client's network stack refused it.
  Note the exact error text; it is the difference between a proxy/DNS problem on
  that machine and a policy.
- **200** — carry on. Confirm the frame appears in DevTools' context selector as
  `www.youtube-nocookie.com`; a document really loaded.

If no `<iframe>` element exists at all after the paste, the failure is ours, not
CEF's: `embedUrlFor` refused the ids. `f()` returning `null` says so
immediately.

## Check 2 — does the artwork host load?

A **second origin** landed with the queue: each row draws its still frame from
`https://img.youtube.com/vi/<id>/mqdefault.jpg` (`thumbnailUrlFor` in
`shared/youtube.ts`). It is a plain image rather than a document, and it is
independent of the embed in both directions — the frame can work while images do
not, and images can work while the frame does not — so it gets its own check
rather than being assumed to ride along on check 1.

With something queued, in the gPhone context:

```js
const a = document.querySelector('img[src^="https://img.youtube.com/"]');
a && { src: a.src, complete: a.complete, width: a.naturalWidth };
```

`naturalWidth: 320` is a real `mqdefault` and the host works. `complete: true`
with `naturalWidth: 0` is a fetch that failed. Or force one, independent of
whatever is on screen:

```js
const probe = new Image();
probe.onload = () => console.log('[art] ok', probe.naturalWidth);
probe.onerror = (e) => console.log('[art] refused', e);
probe.src = 'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
```

**Record this separately from check 1, whichever way it goes.** If it fails,
every queue row draws artwork-less and that reads as a bug in the queue rather
than as a network refusal — which is exactly why it is its own check. And a
client that refuses `img.youtube.com` while loading the embed is a different
finding from one that refuses both; only the second says anything about
third-party frames.

One origin that looks like a third and is not: `www.youtube.com` appears in
`YOUTUBE_MESSAGE_ORIGINS` (`shell/state/music.ts`), but that is a receive-side
allowlist for `postMessage`, not a connection. The frame is loaded from
`youtube-nocookie.com` only and nothing is fetched from `www.youtube.com`, so
there is nothing to test there.

## Check 2a — does the artwork host allow it to be _read_?

A stricter question than check 2, and a separate one: the now-playing card tints
itself from the cover's dominant colour, which means drawing that image into a
canvas and reading the pixels back (`lib/dominantColor.ts`). Loading is a
network question; reading back is a **CORS** question, and a host can answer the
first and refuse the second. If `Access-Control-Allow-Origin` does not come back
for a `cfx-nui-` origin, the canvas is tainted and `getImageData` throws
`SecurityError`.

Only worth running if check 2 passed. In the gPhone context:

```js
const probe = new Image();
probe.crossOrigin = 'anonymous'; // the whole point — without it the canvas taints
probe.onload = () => {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  c.getContext('2d').drawImage(probe, 0, 0, 8, 8);
  try {
    console.log(
      '[art] readable',
      c.getContext('2d').getImageData(0, 0, 1, 1).data
    );
  } catch (e) {
    console.log('[art] tainted', e.name); // SecurityError
  }
};
probe.onerror = () => console.log('[art] refused with crossOrigin set');
probe.src = 'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
```

Three outcomes and they are genuinely different. `readable` means the tint works
in game. `tainted` means the host serves the image but not the header — the
cover still draws and the card is simply the phone's own colour.
`refused with crossOrigin set` while check 2 passed is the interesting one: the
_anonymous_ request was rejected where the plain one was not, which is still
only a missing tint, because the displayed `<img>` deliberately does not carry
the attribute.

**Nothing here can break the card**, and that is the design rather than luck:
every one of these paths resolves `null` and the card renders in the phone's own
theme. So this check is worth recording and is never worth blocking on.

## Check 3 — is the control channel answered?

This is the one the whole `postMessage` design rests on. In the gPhone context:

```js
addEventListener('message', (e) => {
  if (e.source === f()?.contentWindow) console.log('[yt]', e.origin, e.data);
});
```

Then press Play again (or paste a fresh link, which rebuilds the frame and
re-sends the handshake). Within a second or two of the frame loading you should
see a stream of `infoDelivery` messages.

- **Messages arrive** — the channel is live in CEF. This is the single most
  valuable result in the whole procedure; record it in the ticket.
- **Nothing arrives** — the player did not accept the `listening` handshake.
  Drive it by hand to be sure it is not our timing:

  ```js
  const O = 'https://www.youtube-nocookie.com';
  f().contentWindow.postMessage(
    JSON.stringify({
      event: 'listening',
      id: 'gphone-music',
      channel: 'widget'
    }),
    O
  );
  f().contentWindow.postMessage(
    JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
    O
  );
  ```

  Still nothing: the prime suspect is the `origin` URL parameter.
  `https://cfx-nui-gphone` is not an origin YouTube has ever been asked about,
  and it has no dot in its host. Drop it — `embedUrlFor` in
  `shell/state/music.ts`, the `if (origin && …)` line — rebuild, and repeat. If
  that fixes it, the fix is permanent and belongs in that function with a
  comment saying why.

## Check 4 — does it talk back with data, and not just accept commands?

Accepting a command and reporting data are two different capabilities, and the
queue needs both. **A track's title has no fetch behind it**: it arrives in the
same `infoDelivery` payloads check 3 is already printing, as
`info.videoData.title` and `info.videoData.video_id`, and `reportNowPlaying`
(`shell/state/music.ts`) is the only thing that ever supplies one. So the embed
can load, accept `playVideo` and play audibly while this half stays silent — in
which case the queue works and every row is labelled with its id.

With check 3's listener still attached, look inside a payload:

```js
// against one of the [yt] log lines from check 3
JSON.parse(data).info.videoData; // { title, video_id, author, … }
```

- **A title is there** — the queue will be named, and phase 3 works in game.
- **`playerState` arrives but `videoData` never does** — the transport half is
  live and the info half is not. Every row falls back to its id, which is the
  designed behaviour rather than a bug, but say so in the ticket: it is
  invisible from the screen alone, and indistinguishable from "no titles yet".
- **Nothing arrives at all** — that is check 3's failure, not this one.

The title is a string a cross-origin document chose. `normalizeTitle` strips
control characters and bounds the length, and Svelte renders it as text and
never as markup, so a hostile one is a display problem at worst.

## Check 5 — is it playing, or only claiming to?

Read it off the `infoDelivery` payloads the listener above is already printing:

- `info.playerState` — `1` is playing, `3` buffering, `2` paused, `0` ended.
- `info.currentTime` — this is the honest one. A `currentTime` that **advances**
  is a decoder actually running. A state of `1` with a frozen `currentTime` is a
  player that thinks it started and did not.
- an `onError` frame, or an `errorCode` inside an `infoDelivery` — the player
  refusing this video, which the phone now shows on screen. Not a CEF result at
  all; see "A refusal is a result" above, pick another video, and come back.

Now split the outcome, because the halves have completely different causes:

- **`currentTime` advances and you hear it** — done. Phase 1's question is
  answered yes.
- **`currentTime` advances, silence** — not an autoplay problem. It is audio
  output or codec: the client's CEF build, or NUI audio routing. Confirm the
  phone's own sounds still work (Settings > Sound, or any button click — those
  are Web Audio, a different path) and say which of the two works in the ticket.
- **`currentTime` frozen at 0** — autoplay. Go to check 6.

## Check 6 — the autoplay gate nobody has measured

Two questions, and they fail differently. Run both in the gPhone context, with a
track loaded:

```js
document.featurePolicy.allowsFeature('autoplay');
f().featurePolicy.allowsFeature('autoplay', 'https://www.youtube-nocookie.com');
```

- **First is `false`** — the gPhone document itself does not have the `autoplay`
  feature. The default allowlist for `autoplay` is `self`, so a cross-origin
  child frame only has it if the parent delegates it with `allow`. If the phone
  is a nested frame (check 0) and FiveM's root frame embeds it without
  `allow="autoplay"`, we never had the feature to hand down and our own `allow`
  attribute on the player is void. **This is upstream of us and not fixable from
  this repo.**
- **First `true`, second `false`** — our own `allow` attribute is wrong or was
  dropped. That is ours to fix, in `MusicPlayer.svelte`.
- **Both `true`** — delegation is intact, and a frozen player is the client's
  `--autoplay-policy` (a CEF launch flag, set by the FiveM client, not by us)
  applying a gesture requirement.

Use `document.featurePolicy`, not `document.permissionsPolicy`: the newer API is
only partially supported at 103 and will read `undefined` there. Note also that
`document.featurePolicy.allowsFeature('autoplay', '<child origin>')` returns
`false` even when everything is fine — it answers about **this** document's
policy and knows nothing about the iframe's `allow` attribute. The per-element
`f().featurePolicy` form is the one that accounts for both; both forms were
verified against this repo's own build before being written down here.

**If autoplay is the blocker, muted-start does not obviously rescue it.** Muted
playback escapes the gesture requirement but not a disabled `autoplay` feature,
and the phone cannot lend the frame a gesture (see the activation note above). A
muted start plus an unmute on the player's next interaction with the phone is
worth trying if and only if the first check above came back `true`.

## Check 7 — the two things that are only true in game

- **It keeps playing with the phone down.** Start a track, close the phone,
  listen. `MusicPlayer` is mounted outside `Shell.svelte`'s `{#if visible}`
  precisely for this, and the e2e suite asserts the DOM half of it, but only the
  game can tell you the audio half.
- **What an idle embed costs.** Watch the frame rate with a track playing and
  with a track paused but the frame still present. `stopMusic` tears the frame
  down deliberately because phase 1 has no evidence about this; get some.

## If it cannot work

If check 1 shows the client refusing any third-party frame, say so plainly and
stop — there is no parameter to tweak. The fallbacks, in the order they cost:

1. **Drop one attribute at a time, and which one depends on what failed.** A URL
   parameter cannot stop a document loading, so if **check 1** failed the only
   candidate is `sandbox`; if **check 3** failed — the frame loaded and went
   silent — the candidate is the `origin` parameter (`embedUrlFor` in
   `state/music.ts`) and `sandbox` is a distraction. Re-run checks 1–5 after
   each. Note what each buys separately: a player that works only with `sandbox`
   removed is a real security regression (`MusicPlayer.svelte` explains what it
   withholds) and needs its own decision, not a silent commit.
2. **A server-side proxy is not a fallback.** It would mean this resource
   fetching and re-serving Google's player, which is the thing the whole design
   avoided; it also does not solve the codec or the autoplay question.
3. **Native audio** — `PlaySoundFrontend`/a streamed URL through the game's own
   audio, driven from `client/`. That is a different feature with a different
   ticket, and it should be opened as one rather than smuggled in as a fix.

Whatever the answer, write it into [`docs/cef-baseline.md`](cef-baseline.md)'s
inventory. A verified in-game result about a third-party frame is exactly the
kind of thing that file exists to keep, and right now nobody has one.
