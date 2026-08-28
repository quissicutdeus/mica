import { test, expect } from '@playwright/test';

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

    // Attachments sit on every twenty-fifth message, so the default fifty-message window is
    // not guaranteed to hold one. Driving the same "Load older messages" button the
    // virtualization test uses, rather than scrolling, keeps this off scroll physics
    // entirely — three clicks empties the thread's 150 hidden messages deterministically.
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
    const slots = messagesContainer.locator('div.max-w-full.overflow-hidden.rounded-lg');
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

  test('virtualizes message list and lazy-loads older messages on multiple scroll-ups', async ({
    page
  }) => {
    // Select first conversation ListItem by role="button" with force click
    const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
    await expect(convItem).toBeVisible();
    await convItem.click({ force: true });

    // Check header updates to contact name
    const headerTitle = page.locator('button', { hasText: 'Trevor Philips' }).first();
    await expect(headerTitle).toBeVisible();

    const messagesContainer = page.locator('#messages-container');
    await expect(messagesContainer).toBeVisible();

    // Verify initially only 50 messages are rendered in DOM out of 200 (150 hidden)
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).toBeVisible();
    await expect(messagesContainer.locator('button', { hasText: '150 hidden' })).toBeVisible();

    // --- First Scroll Up / Load Older Batch ---
    const loadBtn1 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn1.dispatchEvent('click');
    await expect(messagesContainer.locator('button', { hasText: '100 hidden' })).toBeVisible();

    // --- Second Scroll Up / Load Older Batch ---
    const loadBtn2 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn2.dispatchEvent('click');
    await expect(messagesContainer.locator('button', { hasText: '50 hidden' })).toBeVisible();

    // --- Third Scroll Up / Load Remaining Batch ---
    const loadBtn3 = messagesContainer.locator('button', { hasText: 'Load older messages' });
    await loadBtn3.dispatchEvent('click');

    // Now all 200 messages are loaded and hidden count button is gone
    await expect(
      messagesContainer.locator('button', { hasText: 'Load older messages' })
    ).not.toBeVisible();
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
});
