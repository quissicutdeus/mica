import { test, expect } from '@playwright/test';

/**
 * Blabber, end to end against the browser mock.
 *
 * The first real add-on, so this is also the first time the Store's install path leads to an app
 * that actually does something. `?app=` is dev-only and would skip the install, which is the
 * half worth exercising.
 */
test.describe('Blabber', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Store' }).first().click();
    await page
      .locator('div.rounded-xl', { hasText: 'Blabber' })
      .locator('button', { hasText: 'Install' })
      .click();
    await page.locator("button[aria-label='Back to Home']").click();
    await page.getByRole('button', { name: /Blabber/ }).click();
  });

  /**
   * The first thing a new player sees, which nothing could reach before.
   *
   * Both halves were invisible. The mock fixture always held accounts, so the claim gate never
   * rendered in the browser at all; and uninstalling then reinstalling a bundled add-on used to
   * mount the "Not part of this build" placeholder, because `unregisterApp` deleted a component
   * that was still in the bundle.
   */
  test('asks a brand-new player for a handle before showing a feed', async ({ page }) => {
    // `state=fresh` is an axis of the harness rather than a per-app flag, so it does not repeat
    // the id `app=` has already named.
    await page.goto('/?app=blabber&state=fresh');

    await expect(page.locator('text=Pick a handle')).toBeVisible();
    // No Cancel on the gate: a player holding no account has nothing behind this screen, so a
    // Cancel would dismiss the only thing there is and leave the app empty.
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    // And no composer FAB, because there is no identity to post from yet.
    await expect(page.getByRole('button', { name: 'Blab', exact: true })).toHaveCount(0);

    await page.locator('input[placeholder="handle"]').fill('newcomer');
    await page.getByRole('button', { name: 'Claim', exact: true }).click();

    // Claiming is what reveals the feed, and the new handle is who you post as.
    await expect(page.locator('text=traffic on the interstate')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Posting as @newcomer' })).toBeVisible();
  });

  test('survives being uninstalled and installed again', async ({ page }) => {
    /**
     * The Store resolves `getComponent(id) || placeholderComponent()`, so a component dropped on
     * uninstall means a reinstall mounts the placeholder — for an app whose code never left the
     * bundle. `registry.test.ts` pins the map; this pins the path a player actually walks.
     *
     * Its own `goto`, which also resets the registry, so the sequence is the real one: install,
     * uninstall, install.
     */
    await page.goto('/');
    const storeRow = () => page.locator('div.rounded-xl', { hasText: 'Blabber' });
    const confirm = page.locator('div.z-50', { hasText: 'Uninstall Blabber?' });

    /**
     * Exact role names throughout, not `hasText`. "Uninstall" *contains* "install", so a
     * substring filter matches both buttons — and while the confirm dialog is open there are two
     * of each on the page.
     */
    await page.locator('button', { hasText: 'Store' }).first().click();
    await storeRow().getByRole('button', { name: 'Install', exact: true }).click();
    await storeRow().getByRole('button', { name: 'Uninstall', exact: true }).click();
    await confirm.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await expect(confirm).toHaveCount(0);

    await storeRow().getByRole('button', { name: 'Install', exact: true }).click();

    await page.locator("button[aria-label='Back to Home']").click();
    await page.getByRole('button', { name: /Blabber/ }).click();

    await expect(page.locator('text=Not part of this build')).toHaveCount(0);
    await expect(page.locator('text=traffic on the interstate')).toBeVisible();
  });

  test('shows the feed and renders a mention as its own element', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'Blabber' })).toBeVisible();
    await expect(page.locator('text=traffic on the interstate')).toBeVisible();

    // The mention inside the post body is a button, not text: the body is rendered from tokens
    // rather than from an HTML string, which is what makes a sanitizer unnecessary.
    await expect(
      page
        .locator('article', { hasText: 'anyone up?' })
        .getByRole('button', { name: '@ada', exact: true })
    ).toBeVisible();
  });

  /**
   * The composer is a FAB and a full-screen overlay, not a block pinned above the feed — so
   * every posting test opens it first. `exact` matters: "Blabber" contains "Blab".
   */
  const openComposer = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: 'Blab', exact: true }).click();

  test('posts a Blab and shows it at the top', async ({ page }) => {
    await openComposer(page);
    await page.locator('textarea').fill('e2e was here');
    // Role-based and exact: Blabber's own Store description begins "Post short updates...",
    // and the backgrounded Store app is still in the DOM. `inert` keeps it out of the
    // accessibility tree, which a text match does not respect.
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    await expect(page.locator('text=e2e was here')).toBeVisible();
  });

  test('closes the composer on Back rather than leaving the app', async ({ page }) => {
    /**
     * Every overlay is its own `useAppLevels` rung. One that is not gets skipped, and Back sends
     * the player home from what looks like a modal (§2.7).
     *
     * Backspace rather than the header arrow, and that is the real control: the overlay is
     * `inset-0` like `PhotoPickerModal`, so it paints over the header entirely — the arrow is
     * hidden rather than broken, and the shell dispatches the `back` action regardless of what
     * is on top. Nothing is typed first, because the dispatcher deliberately refuses to fire
     * while a text field has focus.
     */
    await openComposer(page);
    await expect(page.locator('textarea')).toBeVisible();

    await page.keyboard.press('Backspace');

    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.locator('h1', { hasText: 'Blabber' })).toBeVisible();
  });

  test('opens a profile and switches between Blabs and Replies', async ({ page }) => {
    // Scoped to the post rather than `.first()`: several controls carry a handle, and a loose
    // match would click one of those and silently stay on the feed.
    await page
      .locator('article', { hasText: 'anyone up?' })
      .getByRole('button', { name: '@ada', exact: true })
      .click();

    await expect(page.getByRole('button', { name: 'Blabs', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replies', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Replies', exact: true }).click();
    // Ada's replies, not her posts — the tabs are separate server reads, so this is the proof
    // they do not bleed into each other.
    await expect(page.locator('text=thank you')).toBeVisible();

    await page.getByRole('button', { name: 'Blabs', exact: true }).click();
    await expect(page.locator('text=first')).toBeVisible();
  });

  test("opens a profile from a Blab's avatar, not only from the name", async ({ page }) => {
    // A picture of somebody that does nothing when tapped is the one part of a row that looks
    // like a link and is not. Named for where it goes, which also keeps it distinct from the
    // name button beside it.
    await page
      .locator('article', { hasText: 'anyone up?' })
      .getByRole('button', { name: "Night Owl's profile" })
      .click();

    await expect(page.getByRole('button', { name: 'Blabs', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Message @nightowl' })).toBeVisible();
  });

  test('renders markup in a post as text rather than interpreting it', async ({ page }) => {
    await openComposer(page);
    await page.locator('textarea').fill('<b>not bold</b>');
    // Role-based and exact: Blabber's own Store description begins "Post short updates...",
    // and the backgrounded Store app is still in the DOM. `inert` keeps it out of the
    // accessibility tree, which a text match does not respect.
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    // Present as characters, and no element was created from it.
    await expect(page.locator('text=<b>not bold</b>')).toBeVisible();
    await expect(page.locator('article b')).toHaveCount(0);
  });

  test('likes a Blab and fills the heart', async ({ page }) => {
    const first = page.locator('article').first();

    await first.getByRole('button', { name: 'Like' }).click();

    // The label flips because the state did — an optimistic update that only changed a colour
    // would leave the control lying to a screen reader.
    await expect(first.getByRole('button', { name: 'Unlike' })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Unlike' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('mouths a Blab and shows it repeated at the top', async ({ page }) => {
    await page.locator('article').first().getByRole('button', { name: 'Mouth' }).click();

    await expect(page.locator('article').first().locator('text=Mouthed')).toBeVisible();
  });

  test('opens a thread and replies to a reply', async ({ page }) => {
    // `first` has a reply in the fixture, and that reply has its own — which is the point of a
    // reply being a Blab: the same read one level deeper.
    // Scoped by author: "first" also appears inside "congratulations on being first", so a text
    // filter alone matches the reply too.
    await page
      .locator('article', { hasText: '@ada' })
      .filter({ hasText: 'first' })
      .getByRole('button', { name: 'View thread' })
      .click();

    await expect(page.locator('text=congratulations on being first')).toBeVisible();

    // Down another level, into the reply's own thread.
    await page
      .locator('article', { hasText: 'congratulations' })
      .getByRole('button', { name: 'View thread' })
      .click();

    await expect(page.locator('text=thank you')).toBeVisible();

    await page.locator('textarea').fill('and again');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.locator('text=and again')).toBeVisible();
  });

  test('opens a DM thread from the inbox and replies', async ({ page }) => {
    await page.getByRole('button', { name: /Messages/ }).click();

    // One correspondent in the fixture, with an unread message.
    await expect(page.locator('text=saw your post')).toBeVisible();
    await page.locator('button', { hasText: 'nightowl' }).click();

    await page.locator('textarea').fill('thanks!');
    // `Send`, not `Post`. The DM thread had been reusing the public composer, so its button
    // carried the public verb — this assertion is what pins the two composers apart.
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.locator('text=thanks!')).toBeVisible();
  });

  /**
   * Identity. Everything in this block was reachable only from the server before: the menu did
   * not exist, `ClaimHandle` rendered solely at zero accounts so a second handle could not be
   * claimed, and `display_name`/`bio` were client-writable columns with no UI and no route.
   */
  const openIdentityMenu = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: /^Posting as @/ }).click();

  test('switches the posting identity from the header menu', async ({ page }) => {
    await openIdentityMenu(page);

    // Two owned accounts out of a cap of three, which is also what leaves room to claim another.
    await expect(page.locator('text=Posting as · 2 of 3')).toBeVisible();

    await page.locator('button', { hasText: 'ada_alt' }).click();

    // The header avatar names whoever a post would go out as, so it is the proof the switch took.
    await expect(page.getByRole('button', { name: 'Posting as @ada_alt' })).toBeVisible();
  });

  test('dismisses the identity menu by clicking away from it', async ({ page }) => {
    // The scrim is a real button rather than a dimmed div, so the menu is dismissable by the
    // gesture a menu is dismissed by — not only by Back.
    await openIdentityMenu(page);
    await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Close menu' }).click();

    await expect(page.getByRole('button', { name: 'Edit profile' })).toHaveCount(0);
  });

  test('edits a profile, which had no UI at all', async ({ page }) => {
    await openIdentityMenu(page);
    await page.getByRole('button', { name: 'Edit profile' }).click();

    // The handle is shown and not editable — `clientWritable: false` server-side, because a
    // rename would break every mention already posted.
    await expect(page.locator('text=a handle is claimed once')).toBeVisible();

    await page.locator('#blabber-display-name').fill('Ada L');
    await page.locator('#blabber-bio').fill('counting machines');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('text=Profile updated')).toBeVisible();
  });

  test('claims a second handle, which the UI used to make unreachable', async ({ page }) => {
    await openIdentityMenu(page);
    await page.getByRole('button', { name: 'Claim another handle' }).click();

    await page.locator('input[placeholder="handle"]').fill('e2e_alt');
    await page.getByRole('button', { name: 'Claim', exact: true }).click();

    await expect(page.locator('text=Handle claimed')).toBeVisible();
    // Claiming switches to the new identity, as the store does.
    await expect(page.getByRole('button', { name: 'Posting as @e2e_alt' })).toBeVisible();
  });

  test('backs out of claiming a handle without one', async ({ page }) => {
    // The claim overlay is `inset-0` and paints over the header, so its own Cancel is the only
    // on-screen way out — the gate version of this screen deliberately has none, because a
    // player holding no account has nothing to go back to.
    await openIdentityMenu(page);
    await page.getByRole('button', { name: 'Claim another handle' }).click();
    await expect(page.locator('text=Pick a handle')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(page.locator('text=Pick a handle')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Posting as @ada' })).toBeVisible();
  });

  test('starts a DM from a profile, before any thread exists', async ({ page }) => {
    // @nightowl is not one of the player's accounts, so the profile offers to message them —
    // the path the DM empty state has always promised and nothing implemented. The author
    // control is named by display name; `@ada` in the same post is the mention, not the author.
    await page
      .locator('article', { hasText: 'anyone up?' })
      .getByRole('button', { name: 'Night Owl', exact: true })
      .click();

    await page.getByRole('button', { name: 'Message @nightowl' }).click();

    // Titled by the peer rather than the literal "Message", and resolved from the account we
    // already held rather than from an inbox row that may not exist yet.
    await expect(page.locator('h1', { hasText: 'Night Owl' })).toBeVisible();

    await page.locator('textarea').fill('hello from a profile');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.locator('text=hello from a profile')).toBeVisible();
  });

  /**
   * The follow graph and the Following tab.
   *
   * The mock's graph starts empty on purpose, so the first thing these exercise is the empty
   * state — the screen a real player sees before they have followed anybody, and the one most
   * likely to be wrong.
   */
  test.describe('Following', () => {
    const followNightowl = async (page: import('@playwright/test').Page) => {
      await page
        .locator('article', { hasText: 'anyone up?' })
        .getByRole('button', { name: "Night Owl's profile" })
        .click();
      await page.getByRole('button', { name: 'Follow', exact: true }).click();
      // The label flips because the state did, not just the colour.
      await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
    };

    test('starts empty, and says which kind of empty it is', async ({ page }) => {
      await page.getByRole('button', { name: 'Following' }).click();

      await expect(page.locator('text=Nothing from anyone yet')).toBeVisible();
      // Not "nobody has posted" — nobody has been followed, which is a different statement and
      // the one the player can act on.
      await expect(page.locator('text=Follow somebody from their profile')).toBeVisible();
    });

    test('a followed account’s Blabs turn up in the tab', async ({ page }) => {
      await followNightowl(page);

      // Out of the profile, then into the tab.
      await page.keyboard.press('Backspace');
      await page.getByRole('button', { name: 'Following' }).click();

      await expect(page.locator('text=anyone up?')).toBeVisible();
      // Only followed accounts: @ada is the player's own and was never followed.
      await expect(page.locator('text=traffic on the interstate')).toHaveCount(0);
    });

    test('unfollowing empties the tab again', async ({ page }) => {
      await followNightowl(page);
      await page.getByRole('button', { name: 'Following', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();

      await page.keyboard.press('Backspace');
      await page.getByRole('button', { name: 'Following' }).click();

      await expect(page.locator('text=Nothing from anyone yet')).toBeVisible();
    });

    test('the follower count moves with the button', async ({ page }) => {
      await page
        .locator('article', { hasText: 'anyone up?' })
        .getByRole('button', { name: "Night Owl's profile" })
        .click();

      // Counted from the graph rather than stored on the account row, so this is the graph's
      // answer and not a column that could have drifted.
      await expect(page.locator('text=0 followers')).toBeVisible();
      await page.getByRole('button', { name: 'Follow', exact: true }).click();
      await expect(page.locator('text=1 followers')).toBeVisible();
    });

    test('Back leaves Following for the feed before leaving the app', async ({ page }) => {
      // A non-default tab is its own rung. Without it Back sent the player home from Following.
      await page.getByRole('button', { name: 'Following' }).click();
      await expect(page.locator('text=Nothing from anyone yet')).toBeVisible();

      await page.keyboard.press('Backspace');

      await expect(page.locator('text=traffic on the interstate')).toBeVisible();
      await expect(page.locator('h1', { hasText: 'Blabber' })).toBeVisible();
    });

    test('no Follow button on your own profile', async ({ page }) => {
      // Following yourself is refused server-side; offering it would be a button that can only
      // fail. Same reasoning as the Store's Uninstall on a core app.
      await page
        .locator('article', { hasText: 'traffic on the interstate' })
        .getByRole('button', { name: "Ada's profile" })
        .click();

      await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Message @/ })).toHaveCount(0);
    });
  });

  test('a pushed mention raises a toast and moves the badge', async ({ page }) => {
    // Straight down the real `appEvent` path via the dev harness, rather than reaching into the
    // bus — a harness that skipped the parsing would let a malformed envelope look fine in dev.
    await page.evaluate(() =>
      window.pushAppEvent?.(
        'blabber',
        'mention',
        { blab_id: 1 },
        {
          type: 'info',
          title: '@nightowl mentioned you',
          message: 'over here'
        }
      )
    );

    await expect(page.locator('text=@nightowl mentioned you')).toBeVisible();
  });
});
