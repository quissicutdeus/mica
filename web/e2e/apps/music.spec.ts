import { test, expect, type Page } from '@playwright/test';

/**
 * Music, end to end — against a stand-in for YouTube, never YouTube. MICA-111 phase 1.
 *
 * ## Why the player is stubbed rather than loaded
 *
 * Playwright has real network access, so `https://www.youtube-nocookie.com/embed/…` would
 * genuinely load here and the video would genuinely play. That is exactly why it must not:
 * `retries: 0` (see `playwright.config.ts`), so a suite whose green depends on a third
 * party being up, fast, and serving the same player it served last week is a red build and
 * a blocked deploy on a day nobody changed anything. It would also be *dishonest* proof —
 * a modern Chromium loading an embed says nothing about CEF 103, which is the one question
 * phase 1 exists to answer (`docs/testing-music-in-cef.md`).
 *
 * So every request to either YouTube origin is fulfilled from `STUB_PLAYER` below. It is
 * served **at YouTube's own URL**, so the frame's origin really is
 * `https://www.youtube-nocookie.com` and the shell's origin check is exercised for real
 * rather than relaxed for the test. Nothing here reaches the network.
 *
 * ## What this proves
 *
 * Our half of the conversation, which is the half we can fix:
 * - the only thing interpolated into the `src` is a validated id, and the origin is ours;
 * - the frame is created, handshaken, commanded and torn down at the right moments;
 * - a state report from the frame moves the screen, and one forged from anywhere else does
 *   not;
 * - **closing the phone does not tear the player down**, which is the property the whole
 *   shell-owned design exists for and the one thing `index.test.ts` cannot see.
 *
 * ## What it deliberately does not prove
 *
 * That YouTube answers this protocol; that CEF loads a cross-origin iframe at all; that its
 * autoplay policy permits a start without a gesture; that any sound comes out. None of
 * those is answerable in a modern Chromium against a stub — `docs/testing-music-in-cef.md`
 * is the procedure that answers them, at an F8 console, in game.
 */

const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = 'M7lc1UVf-VE';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

const PLAYER = 'iframe[title="gPhone music player"]';

/**
 * A document that speaks the player's half of the IFrame API wire format, and nothing else.
 *
 * It records every command posted into it and can post a state report back out, which is
 * the entire surface `MusicPlayer.svelte` talks to. It plays no media: what is under test
 * is the protocol, and a stub that tried to play something would drag a codec into a suite
 * that cannot judge one.
 */
const STUB_PLAYER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>stub player</title>
  </head>
  <body>
    <script>
      window.__received = [];
      window.addEventListener('message', (event) => {
        try {
          window.__received.push(JSON.parse(event.data));
        } catch {
          window.__received.push({ unparsed: String(event.data) });
        }
      });
      window.__report = (state) => {
        parent.postMessage(
          JSON.stringify({ event: 'infoDelivery', info: { playerState: state } }),
          '*'
        );
      };
      // Both wire shapes, because which one the real player sends is its choice and not
      // ours: onError carries the code bare in info, infoDelivery buries the same failure
      // in an errorCode field. MusicPlayer.svelte honours both, so both are drivable from
      // here. (No backticks in this document -- it is a template literal.)
      window.__error = (code, via) => {
        const message =
          via === 'infoDelivery'
            ? { event: 'infoDelivery', info: { errorCode: code } }
            : { event: 'onError', info: code };
        parent.postMessage(JSON.stringify(message), '*');
      };
    </script>
  </body>
</html>`;

interface PlayerMessage {
  event?: string;
  func?: string;
  args?: unknown[];
  id?: string;
  channel?: string;
}

interface StubWindow {
  __received?: PlayerMessage[];
  __report?: (state: number) => void;
  __error?: (code: number, via?: 'onError' | 'infoDelivery') => void;
}

/**
 * Everything the shell has posted into the current frame.
 *
 * Answers `[]` rather than throwing when there is no frame, or when there is one that a
 * `{#key}` swap is in the middle of replacing, so it is safe inside an `expect.poll`.
 */
const received = async (page: Page): Promise<PlayerMessage[]> => {
  if ((await page.locator(PLAYER).count()) === 0) return [];
  try {
    return await page
      .frameLocator(PLAYER)
      .locator('body')
      .evaluate(() => (window as unknown as StubWindow).__received ?? [], undefined, {
        timeout: 2000
      });
  } catch {
    return [];
  }
};

/** The `func` of each transport command, in the order it was sent. */
const transport = (messages: PlayerMessage[]): string[] =>
  messages
    .filter((message) => message.func === 'playVideo' || message.func === 'pauseVideo')
    .map((message) => message.func as string);

/** The argument of each `setVolume`, in order. */
const volumes = (messages: PlayerMessage[]): number[] =>
  messages
    .filter((message) => message.func === 'setVolume')
    .map((message) => Number(message.args?.[0]));

/** The player telling the phone something, the way the real one's `infoDelivery` does. */
const report = async (page: Page, state: number): Promise<void> => {
  await page
    .frameLocator(PLAYER)
    .locator('body')
    .evaluate((_body, value) => {
      (window as unknown as StubWindow).__report?.(value);
    }, state);
};

/** The player refusing what it was given, in either of the two shapes it uses. */
const errorFrom = async (
  page: Page,
  code: number,
  via: 'onError' | 'infoDelivery' = 'onError'
): Promise<void> => {
  await page
    .frameLocator(PLAYER)
    .locator('body')
    .evaluate(
      (_body, sent) => {
        (window as unknown as StubWindow).__error?.(sent.code, sent.via);
      },
      { code, via }
    );
};

const paste = async (page: Page, value: string): Promise<void> => {
  const field = page.getByLabel('YouTube link');
  await field.fill(value);
  await field.press('Enter');
};

/** Add to the end of the queue without starting it — the app's own Queue button. */
const queue = async (page: Page, value: string): Promise<void> => {
  await page.getByLabel('YouTube link').fill(value);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
};

/** Which video the player is currently pointed at, off the frame's own `src`. */
const loadedVideo = async (page: Page): Promise<string> =>
  new URL((await page.locator(PLAYER).getAttribute('src')) ?? 'https://x/').pathname;

/** Waits out the load handshake, so a test that asserts on commands starts from a known point. */
const settleHandshake = async (page: Page): Promise<void> => {
  await expect.poll(async () => (await received(page))[0]?.event).toBe('listening');
};

test.describe('Music', () => {
  test.beforeEach(async ({ page }) => {
    // Before `goto`, and covering both origins in `YOUTUBE_MESSAGE_ORIGINS` — the point is
    // that no request leaves the machine, not that the one we expect is intercepted.
    await page.route(/https:\/\/www\.youtube(-nocookie)?\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STUB_PLAYER })
    );
    // `?app=` boots straight into the app (see `devHarness.ts`), which is the whole of what
    // these tests need from the launcher.
    await page.goto('/?app=music');
    await expect(page.getByLabel('YouTube link')).toBeVisible();
  });

  // The frame's absence, and deliberately nothing else. What the screen says while nothing
  // is loaded — and what a stop leaves behind on it — belongs to the app and its queue;
  // this spec is about the shell's conversation with the embed, and asserting the app's
  // copy here would fail on a wording change that broke nothing.
  const expectNoPlayer = async (page: Page): Promise<void> => {
    await expect(page.locator(PLAYER)).toHaveCount(0);
  };

  test('renders no player at all until something is loaded', async ({ page }) => {
    await expectNoPlayer(page);
  });

  test('builds the embed from the id alone, at an origin the repo wrote', async ({ page }) => {
    // Deliberately a hostile-looking paste with extra query junk: the assertion below is
    // that none of it reaches an attribute the browser will *navigate*.
    await paste(
      page,
      `https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}&feature=%22onload%3Dalert(1)`
    );

    const frame = page.locator(PLAYER);
    await expect(frame).toHaveCount(1);
    const src = (await frame.getAttribute('src')) ?? '';
    const url = new URL(src);

    expect(url.origin).toBe('https://www.youtube-nocookie.com');
    expect(url.pathname).toBe(`/embed/${VIDEO}`);
    expect(url.searchParams.get('list')).toBe(PLAYLIST);
    expect(url.searchParams.get('enablejsapi')).toBe('1');
    expect(url.searchParams.get('autoplay')).toBe('1');
    expect(url.searchParams.get('controls')).toBe('0');
    expect(url.searchParams.get('disablekb')).toBe('1');
    expect(url.searchParams.get('rel')).toBe('0');
    // Our own origin, named rather than guessed — in game this is `https://cfx-nui-gphone`
    // and is one of the things the in-game procedure checks.
    expect(url.searchParams.get('origin')).toBe(new URL(page.url()).origin);
    expect(src).not.toContain('onload');
    expect(src).not.toContain('feature');

    // The security posture of the element itself, asserted where it is a real DOM
    // attribute rather than a claim in a comment.
    const sandbox = (await frame.getAttribute('sandbox')) ?? '';
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-popups');
    expect(await frame.getAttribute('allow')).toContain('autoplay');
  });

  test('opens a playlist link at videoseries', async ({ page }) => {
    await paste(page, `https://www.youtube.com/playlist?list=${PLAYLIST}`);
    const url = new URL((await page.locator(PLAYER).getAttribute('src')) ?? '');
    expect(url.pathname).toBe('/embed/videoseries');
    expect(url.searchParams.get('listType')).toBe('playlist');
  });

  test('creates no frame, and says so, when the paste is not a YouTube link', async ({ page }) => {
    await paste(page, 'https://example.com/track.mp3');
    await expect(page.getByText(/doesn't look like a YouTube link/)).toBeVisible();
    await expect(page.locator(PLAYER)).toHaveCount(0);
  });

  test('handshakes with the frame, then sets the volume and starts it', async ({ page }) => {
    await paste(page, `https://youtu.be/${VIDEO}`);
    await settleHandshake(page);

    // First message and exactly this shape: without the `listening` handshake the real
    // player answers nothing at all, so an out-of-order or malformed one is a silent
    // "no state ever comes back" rather than an error.
    expect((await received(page))[0]).toEqual({
      event: 'listening',
      id: 'gphone-music',
      channel: 'widget'
    });

    // 50 is `musicVolume`'s default, sent on load rather than waited for — a frame that
    // starts at YouTube's own volume is a frame the phone's slider is lying about.
    await expect.poll(async () => volumes(await received(page))).toContain(50);
    await expect.poll(async () => transport(await received(page))).toEqual(['playVideo']);
  });

  test('sends one transport command per change, and none for a volume nudge', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);
    await expect.poll(async () => transport(await received(page))).toEqual(['playVideo']);

    await page.locator('button[aria-label="Pause"]').click();
    await expect
      .poll(async () => transport(await received(page)))
      .toEqual(['playVideo', 'pauseVideo']);

    await page.locator('button[aria-label="Play"]').click();
    await expect
      .poll(async () => transport(await received(page)))
      .toEqual(['playVideo', 'pauseVideo', 'playVideo']);

    // The dedupe `MusicPlayer.svelte`'s command guard exists for: the volume effect and the
    // transport effect read the same stores, so an unguarded transport would re-send
    // `playVideo` on every nudge — at best noise, at worst a seek.
    await page.getByLabel('Music volume').press('ArrowRight');
    await expect.poll(async () => volumes(await received(page))).toContain(51);
    expect(transport(await received(page))).toEqual(['playVideo', 'pauseVideo', 'playVideo']);
  });

  test('takes a state report from the player and shows it', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);
    await expect(page.getByText('Starting…')).toBeVisible();

    await report(page, 1);
    await expect(page.getByText('Playing', { exact: true })).toBeVisible();
  });

  test('a track ending clears the source and takes the frame with it', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);
    await report(page, 1);
    await expect(page.getByText('Playing', { exact: true })).toBeVisible();

    await report(page, 0);
    await expectNoPlayer(page);
  });

  test('ignores a state report that did not come from the player', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);
    await report(page, 1);
    await expect(page.getByText('Playing', { exact: true })).toBeVisible();

    // Same payload, posted from the shell's own document — so `event.origin` is the app's
    // and not YouTube's. Only a real browser can judge this: jsdom lets a test set
    // `origin` to whatever it likes.
    await page.evaluate(() => {
      window.postMessage(JSON.stringify({ event: 'infoDelivery', info: { playerState: 0 } }), '*');
    });

    // A bare "nothing happened" assertion passes instantly whether or not the guard works,
    // so the positive control is second: the same report *from the frame* must still land.
    // If it does, the channel was live throughout and the forged one was refused on its
    // origin rather than lost in a race.
    await expect(page.locator(PLAYER)).toHaveCount(1);
    await report(page, 0);
    await expect(page.locator(PLAYER)).toHaveCount(0);
  });

  test('stop tears the frame down rather than leaving a silent one running', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);

    await page.locator('button[aria-label="Stop"]').click();
    await expectNoPlayer(page);
  });

  test('a second paste rebuilds the frame and handshakes again', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);

    await paste(page, OTHER_VIDEO);
    await expect
      .poll(async () => new URL((await page.locator(PLAYER).getAttribute('src')) ?? '').pathname)
      .toBe(`/embed/${OTHER_VIDEO}`);
    // A fresh document, not a `src` swap: the new frame has recorded exactly one message so
    // far and it is the handshake. A swapped `src` would arrive against a `ready` flag and a
    // command guard left over from the previous track.
    await settleHandshake(page);
    await expect.poll(async () => transport(await received(page))).toEqual(['playVideo']);
  });

  /**
   * The refusal path, end to end (MICA-111).
   *
   * This is the branch that made the in-game procedure ambiguous before it existed: an
   * uploader who disabled embedding — a large fraction of the music on YouTube — left the
   * phone on "Starting…" forever, which looks exactly like CEF refusing the frame. The
   * whole point of surfacing it is that the two are now distinguishable, and that only
   * holds if the wording, the codes and the no-auto-skip rule all actually reach a screen.
   *
   * Driven through the stub's `__error`, so a real refusal never has to be provoked from
   * YouTube — there is no reliably-unembeddable video to depend on, and depending on one
   * would be the third-party green this whole spec avoids.
   */
  test.describe('a track the player refuses', () => {
    const REFUSALS = [
      { code: 101, says: "Can't be played outside YouTube" },
      { code: 150, says: "Can't be played outside YouTube" },
      { code: 100, says: 'Unavailable — removed or private' },
      { code: 2, says: "Can't be played" }
    ];

    for (const { code, says } of REFUSALS) {
      test(`says why for code ${code}`, async ({ page }) => {
        await paste(page, VIDEO);
        await settleHandshake(page);
        await errorFrom(page, code);

        // The status word first: a refused track must never read as "Playing", and the
        // reason line under it is the one line on the screen that explains the silence.
        await expect(page.getByText("Can't play this", { exact: true })).toBeVisible();
        await expect(page.getByText(`${says} · skip or remove it`)).toBeVisible();
      });
    }

    test('honours the errorCode shape as well as the onError one', async ({ page }) => {
      // Which of the two the player sends is its choice, not ours. A spec that only drove
      // `onError` would leave half of `MusicPlayer.svelte`'s parsing unexercised.
      await paste(page, VIDEO);
      await settleHandshake(page);
      await errorFrom(page, 101, 'infoDelivery');
      await expect(page.getByText("Can't play this", { exact: true })).toBeVisible();
    });

    /**
     * **No auto-skip, and this is deliberate rather than an oversight.**
     *
     * A queue that quietly moved past a refused track would be how somebody running
     * `docs/testing-music-in-cef.md` concludes the embed works in game when it does not:
     * the phone would look busy, nothing would play, and no screen would say why. So a
     * failure holds, and the person decides.
     *
     * Both halves are asserted, because the second is easy to reintroduce: an `ended` that
     * arrives *after* an error must not advance either (`reportPlayerState` bails on the
     * error state). Without that guard a player that reports both would skip on its own
     * through exactly the path this test exists to close.
     */
    test('holds rather than skipping to the next track', async ({ page }) => {
      await paste(page, VIDEO);
      await settleHandshake(page);
      await queue(page, OTHER_VIDEO);

      await errorFrom(page, 101);
      await expect(page.getByText("Can't play this", { exact: true })).toBeVisible();
      expect(await loadedVideo(page)).toBe(`/embed/${VIDEO}`);

      await report(page, 0);
      await expect(page.getByText("Can't play this", { exact: true })).toBeVisible();
      expect(await loadedVideo(page)).toBe(`/embed/${VIDEO}`);

      // Counted rather than compared: entering the error state does send a `pauseVideo`,
      // which is correct — stop asking a player that has refused. What must not happen is a
      // *second* `playVideo`, which is what advancing to the queued track would produce and
      // is the only thing that distinguishes holding from skipping on this channel.
      const played = transport(await received(page)).filter((func) => func === 'playVideo');
      expect(played).toEqual(['playVideo']);
    });

    test('leaves the reason on the queue row after moving past it', async ({ page }) => {
      await paste(page, VIDEO);
      await settleHandshake(page);
      await queue(page, OTHER_VIDEO);
      await errorFrom(page, 101);

      // Two places while it is loaded: the now-playing card and the row.
      await expect(page.getByText(/Can't be played outside YouTube/)).toHaveCount(2);

      await page.locator('button[aria-label="Next"]').click();
      await expect.poll(async () => loadedVideo(page)).toBe(`/embed/${OTHER_VIDEO}`);

      // The card has moved on and the row has not: the list still says which track is bad,
      // which is the whole reason the failure is recorded twice (`reportPlayerError`).
      await expect(page.getByText("Can't play this", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/Can't be played outside YouTube/)).toHaveCount(1);
    });

    test('offers no play button for it, in the app or in the shade', async ({ page }) => {
      await paste(page, VIDEO);
      await settleHandshake(page);
      await errorFrom(page, 101);

      // In the app the transport stays in place and is disabled — the other buttons around
      // it (skip, remove) are still the point of the screen.
      await expect(page.locator('button[aria-label="Play"]')).toBeDisabled();

      // In the shade it is absent rather than disabled: `resumeMusic` is a no-op on a
      // refused track, and a button that does nothing is worse than one not offered. Stop
      // is beside it and still works, which is what the row is for.
      await page.getByRole('button', { name: 'Open notification shade' }).click();
      const row = page.getByRole('group', { name: 'Now playing' });
      await expect(row).toBeVisible();
      // `exact`, and it matters: role-name matching is substring and case-insensitive by
      // default, and the row's own button is named after the status — "Can't play …" —
      // which contains "play" and matched a button that is genuinely gone.
      await expect(row.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Stop music' })).toBeVisible();
    });
  });

  /**
   * The hidden player must not be reachable by keyboard (MICA-109's gate cannot see it).
   *
   * `a11y.spec.ts` scopes every axe scan to `[data-testid="phone-frame"]`, and this frame is
   * mounted *outside* that — outside `{#if visible}` — so the whole sweep, in both schemes,
   * walks straight past it. axe's `aria-hidden-focus` rule is exactly the rule for this
   * shape and it is never asked.
   *
   * It was reachable. An `<iframe>` is tabbable by default and `aria-hidden` does nothing
   * about that, so a Tab cycle landed on an invisible 200x200 box with no focus ring, and a
   * real player document has its own controls to descend into after it. `inert` on the
   * wrapper is the fix, and it is the call `Shell.svelte` already makes for a backgrounded
   * app; this is what keeps it made.
   */
  test('the hidden player is not in the tab order', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);

    // A full cycle and then some: focus wraps back to the top, so anything reachable at all
    // is reached inside 40 presses of a screen this size.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const reached: string[] = [];
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab');
      reached.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return 'null';
          return `${el.tagName}:${el.getAttribute('title') ?? el.getAttribute('aria-label') ?? ''}`;
        })
      );
    }

    expect(
      reached.filter((what) => what.startsWith('IFRAME')),
      reached.join(' ')
    ).toEqual([]);
    // And the shell is still keyboard-operable — a cycle that reached nothing at all would
    // pass the assertion above for the wrong reason.
    expect(reached.some((what) => what.startsWith('BUTTON'))).toBe(true);
  });

  /**
   * The shade's now-playing row, which is the off switch for a track that is still audible
   * after the phone is put away (`NowPlaying.svelte`).
   *
   * Two reasons it needs its own assertion. It renders only `{#if $musicSource}`, so the
   * a11y sweep's shade scan — which runs with nothing playing — never sees it at all. And
   * the shade is a focus-trapped surface since MICA-66, so a control that is present but
   * unlabelled or unreachable there is worse than one on an ordinary screen.
   */
  test('the shade offers a labelled, reachable transport while a track is loaded', async ({
    page
  }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);

    await page.getByRole('button', { name: 'Open notification shade' }).click();
    const row = page.getByRole('group', { name: 'Now playing' });
    await expect(row).toBeVisible();

    // Named by role, not by test id: this is an assertion about what a screen reader is
    // offered, and a `data-testid` is invisible to one.
    await expect(row.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Stop music' })).toBeVisible();
    // The row's own button, and note what names it: `NowPlaying.svelte` puts
    // `title="Open Music"` on it, but a `title` is only a *fallback* name and this button
    // has content, so what a screen reader actually announces is the status and the track.
    // Asserted as it really is rather than as the attribute suggests — a spec that matched
    // "Open Music" would be asserting a name nothing produces.
    const open = row.getByRole('button', { name: new RegExp(VIDEO) });
    await expect(open).toBeVisible();

    // Reachable by keyboard from inside the trapped sheet, and it actually works.
    await row.getByRole('button', { name: 'Stop music' }).focus();
    await expect(row.getByRole('button', { name: 'Stop music' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expectNoPlayer(page);
    await expect(page.getByRole('group', { name: 'Now playing' })).toHaveCount(0);
  });

  /**
   * The property the whole design is arranged around (MICA-111, `Shell.svelte`).
   *
   * `MusicPlayer` is mounted outside `{#if visible}` precisely so that lowering the phone
   * destroys the frame, the toasts and every resident app but not the thing making noise.
   * Nothing below the shell can assert this: `index.test.ts` renders the app alone, and the
   * unit tests for `state/music.ts` never mount a player at all.
   */
  test('keeps playing when the phone is put away', async ({ page }) => {
    await paste(page, VIDEO);
    await settleHandshake(page);
    await report(page, 1);
    await expect(page.getByText('Playing', { exact: true })).toBeVisible();
    const src = await page.locator(PLAYER).getAttribute('src');

    // Asserted on the collapsed-phone affordance rather than on `<main>` being gone: in a
    // browser the frame's outro never completes and `<main>` stays in the DOM. See the note
    // in `keybinds.spec.ts`.
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: false }, '*');
    });
    await expect(page.getByRole('button', { name: /Open gPhone/i })).toBeVisible();

    await expect(page.locator(PLAYER)).toHaveCount(1);
    expect(await page.locator(PLAYER).getAttribute('src')).toBe(src);
    // The same document, not a rebuilt one — a remount would have wiped what it recorded.
    expect((await received(page))[0]?.event).toBe('listening');

    // And the controller picks the running track back up from shell state, rather than
    // coming back to an empty screen while something is still playing.
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: true }, '*');
    });
    await expect(page.getByText('Playing', { exact: true })).toBeVisible();
  });
});
