import { test, expect } from '../support/test';

test.describe('Messages App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Messages' }).first().click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();
  });

  test('renders Messages header and conversational UI', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Messages' });
    await expect(title).toBeVisible();
  });

  /**
   * A photo attachment draws its picture, rather than the placeholder `MediaThumb` falls
   * back to when a row has no still (MICA-110).
   *
   * **This guards the join, not the projection.** A message attachment does not come from
   * the media service's list read — it is hydrated by `MessageRepository`, whose SQL names
   * `p.data` explicitly — so `data: { private: true }` never reached it and attachments were
   * never at risk from that change. What they *are* at risk from is the obvious follow-on:
   * now that photos carry a thumbnail, narrowing that join the same way the list read was
   * narrowed looks like the same win, and would silently blank every attachment in every
   * conversation. Nothing else in the suite would notice, because until this test no spec
   * anywhere asserted that an attachment renders at all.
   *
   * `naturalWidth > 0` rather than the presence of an `<img>`: `MediaThumb` draws a labelled
   * `<div>` when it has no still, so an element check is most of the answer already — but an
   * `<img>` whose `src` never resolved is indistinguishable from a working one by every DOM
   * assertion except this one.
   */
  test('a photo attachment renders its picture, not a placeholder', async ({ page }) => {
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    // Attachments sit on every twenty-fifth message, so the first fifty-message page is
    // not guaranteed to hold one. Driving the same "Load older messages" button the
    // paging test uses, rather than scrolling, keeps this off scroll physics entirely —
    // three clicks fetches the thread's remaining 150 messages deterministically.
    for (let i = 0; i < 3; i += 1) {
      await messagesContainer
        .locator('button', { hasText: 'Load older messages' })
        .dispatchEvent('click');
    }
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).not.toBeVisible();

    // Every attachment slot, not the first one. `alt="Attachment"` is passed for every
    // non-location attachment alike, so `.first()` lands on whichever the thread happens to
    // render first — and this thread's multi-attachment message leads with a *video*, which
    // draws from `thumbnail` and would keep drawing it however badly the photo path broke.
    // A mutation test caught exactly that: stripping `data` from the photo fixture left this
    // assertion green.
    //
    // Counting undrawn slots is also what makes a placeholder detectable at all. A row with
    // no still renders a `<div>` and no `<img>`, so the image simply disappears rather than
    // going blank — an assertion scoped to images would have nothing left to fail on.
    const slots = messagesContainer.locator('[data-testid="attachment-slot"]');
    await expect(slots.first(), 'the thread must actually contain an attachment').toBeVisible();

    await expect
      .poll(
        async () =>
          await slots.evaluateAll(
            (els) =>
              els.filter((el) => {
                const img = el.querySelector('img');
                return !img || (img as HTMLImageElement).naturalWidth === 0;
              }).length
          ),
        { timeout: 10_000 }
      )
      .toBe(0);
  });

  /**
   * A thread arrives one page at a time and grows upward as older pages are asked for
   * (MICA-212). The mock answers `messages:get` the way the server does — fifty rows,
   * newest first, and a cursor for the page behind them — so the 200-message fixture is
   * four fetches, not one fetch and three local reveals. What is asserted is what the
   * player sees: fifty bubbles, then a hundred, and the control gone once the oldest
   * message is in the DOM.
   *
   * The label carries no "hidden" count here, deliberately: nothing is hidden locally when
   * every loaded row is rendered, and the phone does not know how long the thread is on the
   * server. That number was the old suite's proof of a client-side window; the bubble count
   * is this one's proof of a server-side one.
   */
  test('loads a thread one page at a time, older pages on demand', async ({ page }) => {
    // Select first conversation ListItem by role="button" with force click
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    // Check header updates to contact name
    const headerTitle = page.locator('button', { hasText: 'Trevor Philips' }).first();
    await expect(headerTitle).toBeVisible();

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    const bubbles = messagesContainer.locator('[id^="msg-"]');
    const loadOlder = messagesContainer.locator('button', { hasText: 'Load older messages' });

    // The newest page only, and the newest message of the fixture is in it.
    await expect(bubbles).toHaveCount(50);
    await expect(page.locator('#msg-3200')).toBeVisible();
    await expect(page.locator('#msg-3150')).toHaveCount(0);
    await expect(loadOlder).toBeVisible();
    await expect(messagesContainer.locator('button', { hasText: 'hidden' })).toHaveCount(0);

    // --- First page back ---
    await loadOlder.dispatchEvent('click');
    await expect(bubbles).toHaveCount(100);
    await expect(page.locator('#msg-3150')).toBeVisible();

    // --- Second ---
    await loadOlder.dispatchEvent('click');
    await expect(bubbles).toHaveCount(150);

    // --- Third: the oldest message arrives and the control goes with it ---
    await loadOlder.dispatchEvent('click');
    await expect(bubbles).toHaveCount(200);
    await expect(page.locator('#msg-3001')).toBeVisible();
    await expect(loadOlder).not.toBeVisible();
  });

  /**
   * In-chat search says what it covers, and can be made to cover everything (MICA-218).
   *
   * The thread is paged, so a search over the held pages misses older messages. Rather
   * than a quiet wrong answer, the search bar names the limit while older pages exist and
   * offers to fetch the rest; once the oldest page is in, the note goes and the same query
   * matches the whole fixture. Trevor's thread cycles five prompts across 200 messages, so
   * "machete" is in every fifth one: ten on the first page, forty in the whole thread.
   */
  test('in-chat search names what it covers and can load the whole thread', async ({ page }) => {
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await convItem.click({ force: true });
    await expect(page.locator('button', { hasText: 'Trevor Philips' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Search Messages' }).click();
    await page.getByPlaceholder('Search in conversation...').fill('machete');

    const messagesContainer = page.locator('#messages-container');
    const bubbles = messagesContainer.locator('[id^="msg-"]');
    const note = page.getByRole('status').filter({ hasText: 'Searching loaded messages only' });
    const loadAll = page.getByRole('button', { name: 'Load the whole conversation' });

    await expect(bubbles).toHaveCount(10);
    await expect(note).toBeVisible();
    await expect(loadAll).toBeVisible();

    await loadAll.click();

    await expect(bubbles).toHaveCount(40);
    await expect(page.locator('#msg-3003')).toBeVisible();
    await expect(note).toHaveCount(0);
  });

  /**
   * Archive, then unarchive, end to end (MICA-208). The second half is the one that
   * never worked: the server read a flag the web did not send and defaulted it to
   * "archive", so a thread put away could not be brought back. The browser mock always
   * honoured `status`, which is exactly why no spec noticed — this one asserts the round
   * trip through the same store the game uses, and the contract now refuses a request
   * that does not name its direction.
   */
  test('archives a thread and brings it back to the inbox', async ({ page }) => {
    const inboxRow = () => page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    const archiveButton = () => page.getByRole('button', { name: 'Archive Conversation' });
    const toggleArchive = () => page.getByRole('button', { name: 'Toggle Archive' });

    await inboxRow().click({ force: true });
    await expect(archiveButton()).toHaveAttribute('title', 'Archive');
    await archiveButton().click();

    // Back on the inbox, and Trevor is no longer in it.
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();
    await expect(inboxRow()).toHaveCount(0);

    await toggleArchive().click();
    await expect(page.locator('h1', { hasText: 'Archived Messages' })).toBeVisible();
    await expect(inboxRow()).toBeVisible();

    await inboxRow().click({ force: true });
    await expect(archiveButton()).toHaveAttribute('title', 'Unarchive');
    await archiveButton().click();

    // The archive is empty again, and the inbox has Trevor back.
    await expect(page.locator('h1', { hasText: 'Archived Messages' })).toBeVisible();
    await expect(inboxRow()).toHaveCount(0);
    await toggleArchive().click();
    await expect(page.locator('h1', { hasText: 'Messages' })).toBeVisible();
    await expect(inboxRow()).toBeVisible();
  });

  test('shares a location and sets a waypoint from it', async ({ page }) => {
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    await expect(page.locator('button', { hasText: 'Trevor Philips' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Attachments' }).click();
    await page.locator('button', { hasText: 'Location' }).click();

    // Sharing the location is async — wait for the attach tray to actually show it (its
    // remove button) before sending, or Send fires while the share is still in flight.
    await expect(page.getByRole('button', { name: 'Remove attachment' })).toBeVisible();

    const messagesContainer = page.locator('#messages-container');
    await page.getByRole('button', { name: 'Send' }).click();

    // The sent bubble renders the location placeholder plus its resolved label, and an
    // "Add Waypoint" affordance that a plain photo/gif/etc. attachment never gets.
    const waypointButton = messagesContainer.locator('button', { hasText: 'Add Waypoint' }).first();
    await expect(waypointButton).toBeVisible();
    await expect(waypointButton.locator('text=Vespucci Beach')).toBeVisible();

    await waypointButton.click();

    // The mock's `setWaypoint` can't call a real native in a browser, so the assertion is
    // on the toast/feedback path only, never on map state.
    await expect(page.locator('text=Waypoint set')).toBeVisible();
  });

  /**
   * Editing and unsending your own message (MICA-68).
   *
   * Driven end to end rather than asserted on the store, because the wiring is where this
   * feature can break silently: the bubble reveals its actions on tap, an edit borrows the
   * one composer the thread already has, and Send has two destinations depending on whether
   * an edit is in progress. None of that is visible to a unit test of the store.
   *
   * A fresh message is sent first so the test owns its subject — the seeded thread's rows
   * are shared with the virtualization and attachment specs above.
   */
  test('edits a sent message, marks it edited, then unsends it for everyone', async ({ page }) => {
    await page
      .locator('[role="button"]')
      .filter({ hasText: 'Trevor' })
      .first()
      .click({ force: true });

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    await page.getByRole('textbox').last().fill('Meet me at the docs');
    await page.getByRole('button', { name: 'Send' }).click();

    const bubble = messagesContainer.locator('button', { hasText: 'Meet me at the docs' }).last();
    await expect(bubble).toBeVisible();

    // Tapping the bubble reveals the per-message actions; Edit and Unsend appear only on
    // your own messages.
    await bubble.click();
    await page.getByRole('button', { name: 'Edit message' }).click();

    await expect(page.locator('text=Editing message')).toBeVisible();
    await page.getByRole('textbox').last().fill('Meet me at the docks');
    await page.getByRole('button', { name: 'Send' }).click();

    const edited = messagesContainer.locator('button', { hasText: 'Meet me at the docks' }).last();
    await expect(edited).toBeVisible();
    await expect(messagesContainer.locator('text=Meet me at the docs').first()).toHaveCount(0);
    // The trace the recipient sees. Without it an edit is a silent rewrite of what they read.
    await expect(
      messagesContainer.locator('span', { hasText: 'Edited' }).last(),
      'an edited message says so'
    ).toBeVisible();

    await edited.click();
    await page.getByRole('button', { name: 'Unsend message' }).click();

    // The confirmation names the consequence: this is a delete for everyone, not a hide.
    await expect(page.locator('text=for everyone in it')).toBeVisible();
    await page.getByRole('button', { name: 'Unsend', exact: true }).click();

    await expect(
      messagesContainer.locator('button', { hasText: 'Meet me at the docks' })
    ).toHaveCount(0);
  });

  /**
   * `PhoneFrame`'s home-indicator gesture bar is a real full-width button at `z-60` sitting
   * across the bottom of the screen, so a composer flush to that edge has its lower third
   * inside a target that leaves the app. It was invisible for as long as the thread column
   * was unbounded and the composer was thousands of pixels below the screen (MICA-89);
   * anchoring it correctly is what brought the two into contact.
   */
  test('the composer keeps clear of the home indicator', async ({ page }) => {
    await page
      .locator('[role="button"]')
      .filter({ hasText: 'Trevor' })
      .first()
      .click({ force: true });
    await expect(page.locator('#messages-container')).toBeVisible();

    const send = await page.getByRole('button', { name: 'Send' }).first().boundingBox();
    const home = await page.locator("button[aria-label='Return to home screen']").boundingBox();
    expect(send, 'the Send button is on screen').not.toBeNull();
    expect(home, 'the home indicator is on screen').not.toBeNull();

    // Strictly above, not merely not-overlapping: an edge exactly on the bar's reads as
    // touching it and still puts the tap target within a pixel of the wrong action.
    expect(send!.y + send!.height, 'Send sits above the gesture bar').toBeLessThan(home!.y);
  });

  /**
   * Reactions (MICA-143), on the shared primitive Blabber's DMs already use
   * (`createReactionStore`/`ReactionBar`, MICA-98). Driven through the actual
   * emoji-picker affordance rather than the store directly, because the wiring — the
   * three-file NUI round trip plus the browser mock registry (AGENTS.md §8) — is exactly
   * what fails silently if a layer is missing, and a unit test of `createReactionStore`
   * already covers the toggle/optimism/rollback logic in isolation.
   */
  test('reacts to a message and removes the reaction by tapping the chip again', async ({
    page
  }) => {
    await page
      .locator('[role="button"]')
      .filter({ hasText: 'Trevor' })
      .first()
      .click({ force: true });

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    // The newest message, not the oldest: the thread opens scrolled to the bottom, so
    // this one is already on screen. `.first()` would be the oldest of the loaded
    // window and typically off-screen above it — Playwright scrolls an off-screen
    // target into view before clicking, and scrolling up that far crosses the
    // infinite-scroll-up threshold, which prepends another page of older messages and
    // leaves the (re-evaluated, lazy) `.first()` locator pointing at a brand-new
    // element that was never reacted to.
    const message = messagesContainer.locator('[id^="msg-"]').last();
    await expect(message).toBeVisible();

    await message.getByRole('button', { name: 'React with 👍' }).click();

    const chip = message.getByRole('button', { name: /^👍 reaction, 1,/ });
    await expect(chip).toBeVisible();
    await expect(chip, "the tapped chip is the player's own reaction").toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await chip.click();
    await expect(message.getByRole('button', { name: /^👍 reaction,/ })).toHaveCount(0);
    // The picker itself survives the round trip either way — reacting again is still on offer.
    await expect(message.getByRole('button', { name: 'React with 👍' })).toBeVisible();
  });

  /**
   * The group-conversation rendering question MICA-143 raised and asked to be settled:
   * what a reaction looks like once a thread has more than two participants, unlike
   * Blabber's DMs which are always 1:1.
   *
   * The decision: nothing changes. `ReactionBar` never shows *who* reacted, only a count
   * and whether one of them is the viewer's own (see `conversations.ts`'s
   * `messageReactions` docblock), so a count is already participant-count agnostic by
   * construction — widening it to name reactors would be a wider server contract than
   * this ticket's "point Messages at the existing primitive". This test is what makes
   * that decision a checked fact rather than an assertion in a docblock: the fixture
   * seeds two *other* participants' reactions on a message in a >2-person thread, and the
   * count aggregates them correctly before the player has reacted at all, then again once
   * the player's own tap is added on top.
   */
  test('aggregates reactions from other participants in a group conversation', async ({ page }) => {
    await page
      .locator('[role="button"]')
      .filter({ hasText: 'Union Depository Heist' })
      .first()
      .click({ force: true });

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    // The seeded message is the thread's oldest, behind three "Load older" pages — the
    // same technique the attachment spec above uses to reach a deterministic row.
    for (let i = 0; i < 3; i += 1) {
      await messagesContainer
        .locator('button', { hasText: 'Load older messages' })
        .dispatchEvent('click');
    }
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).not.toBeVisible();

    const message = page.locator('#msg-2001');
    await expect(message).toBeVisible();

    const seeded = message.getByRole('button', { name: /^🔥 reaction, 2,/ });
    await expect(seeded, 'two other participants already reacted').toBeVisible();
    await expect(seeded).toHaveAttribute('aria-pressed', 'false');

    await seeded.click();
    const withMine = message.getByRole('button', { name: /^🔥 reaction, 3,/ });
    await expect(withMine, "the player's own tap adds to the existing two").toBeVisible();
    await expect(withMine).toHaveAttribute('aria-pressed', 'true');

    await withMine.click();
    await expect(
      message.getByRole('button', { name: /^🔥 reaction, 2,/ }),
      'taking it back leaves the other two participants alone'
    ).toBeVisible();
  });
});
