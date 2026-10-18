import type { FrameLocator, Page } from '@playwright/test';
import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, dismissToasts, installAddOn } from '../support/addon';

/**
 * Glimpse (MICA-253), end to end against the browser mock.
 *
 * Fixture, from `mocks/social.ts`: the player owns @ada (20); @lens_lena (21) and @nightowl
 * (22) are other people. Twelve posts, 12 newest and @ada's own, with two comments on it by
 * the others. Post 11 is @lens_lena's and carries a comment by @ada; post 10 is @nightowl's and
 * carries a comment by @lens_lena. Those three give every branch of "who may remove a comment"
 * a row to act on without setup.
 *
 * Reached through the Store, as Blabber's spec is: `?app=` would skip the install.
 */
test.describe('Glimpse', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['store', 'admin']);
    await page.goto('/');
    await installAddOn(page, 'Glimpse');
    await page.getByRole('button', { name: /Glimpse/ }).click();
    // The install toast sits over the top strip of the frame and swallows clicks — see
    // `dismissToasts`.
    await dismissToasts(page);
  });

  const post = (frame: FrameLocator, id: number) =>
    frame.locator(`article[data-testid="glimpse-post"][data-post-id="${id}"]`);

  /** Open a post's own screen from the feed and wait for its comment section. */
  const openPost = async (frame: FrameLocator, id: number) => {
    await post(frame, id).getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(frame.getByTestId('glimpse-comments')).toBeVisible();
  };

  test('shows the whole feed, newest first, as @ada', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    const posts = frame.getByTestId('glimpse-post');

    await expect(posts).toHaveCount(12);
    await expect(posts.first()).toHaveAttribute('data-post-id', '12');
    await expect(posts.last()).toHaveAttribute('data-post-id', '1');
    await expect(frame.getByRole('button', { name: 'Posting as @ada' })).toBeVisible();
    await expect(frame.getByRole('article', { name: 'Post by @ada' })).toHaveCount(4);
  });

  test('pages through a post with several photos', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    // Post 12 carries three photos; post 11 carries one and so no carousel controls at all.
    const card = post(frame, 12);
    const position = card.getByTestId('glimpse-carousel-position');
    await expect(position).toHaveText('1/3');
    await expect(card.getByRole('button', { name: 'Previous photo' })).toHaveCount(0);

    await card.getByRole('button', { name: 'Next photo' }).click();
    await expect(position).toHaveText('2/3');
    await card.getByRole('button', { name: 'Next photo' }).click();
    await expect(position).toHaveText('3/3');
    await expect(card.getByRole('button', { name: 'Next photo' })).toHaveCount(0);

    await card.getByRole('button', { name: 'Previous photo' }).click();
    await expect(position).toHaveText('2/3');

    await expect(post(frame, 11).getByTestId('glimpse-carousel-position')).toHaveCount(0);
  });

  test('likes and unlikes a post, and the count follows', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    // Post 12 is seeded with two ❤️ from other accounts, so the count has somewhere to start
    // that is not zero — a toggle that only flipped the label would leave the number behind.
    const card = post(frame, 12);
    const count = card.getByTestId('glimpse-like-count');
    await expect(count).toHaveText('2');

    await card.getByRole('button', { name: 'Like', exact: true }).click();
    const unlike = card.getByRole('button', { name: 'Unlike', exact: true });
    await expect(unlike).toHaveAttribute('aria-pressed', 'true');
    await expect(count).toHaveText('3');

    await unlike.click();
    const like = card.getByRole('button', { name: 'Like', exact: true });
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(count).toHaveText('2');
  });

  test('Following is empty until somebody is followed, then shows only their posts', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'glimpse');
    await frame.getByRole('button', { name: 'Following', exact: true }).click();
    await expect(frame.locator('text=Nothing from anyone yet')).toBeVisible();
    await expect(frame.getByTestId('glimpse-post')).toHaveCount(0);

    await frame.getByRole('button', { name: 'For you', exact: true }).click();
    await post(frame, 11).getByRole('button', { name: "Lena's profile" }).click();
    await frame.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Following', exact: true })).toBeVisible();

    // Back to the feed (Backspace is the shell's Back, as in Blabber's spec), then the tab.
    await page.keyboard.press('Backspace');
    await frame.getByRole('button', { name: 'Following', exact: true }).click();

    // Lena wrote 1, 4, 5, 8 and 11; nobody else's post can be here.
    const posts = frame.getByTestId('glimpse-post');
    await expect(posts).toHaveCount(5);
    await expect(frame.getByRole('article', { name: 'Post by @lens_lena' })).toHaveCount(5);
  });

  test('opens a post and adds a comment, which lands at the top', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openPost(frame, 11);

    const comments = frame.getByTestId('glimpse-comment');
    await expect(comments).toHaveCount(1);

    await frame.getByPlaceholder('Add a comment…').fill('e2e was here');
    await frame.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(comments).toHaveCount(2);
    await expect(comments.first()).toContainText('e2e was here');
    await expect(comments.first()).toContainText('ada');
    await expect(frame.getByPlaceholder('Add a comment…')).toHaveValue('');
  });

  test("the owner removes somebody else's comment on their own post", async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openPost(frame, 12);

    const comments = frame.getByTestId('glimpse-comment');
    await expect(comments).toHaveCount(2);
    // @lens_lena's comment, on @ada's post: not the player's words, removable all the same.
    const theirs = frame.locator('[data-testid="glimpse-comment"][data-comment-id="1"]');
    await expect(theirs).toContainText('love this road');
    await expect(theirs.getByRole('button', { name: 'Report comment' })).toHaveCount(0);

    await theirs.getByRole('button', { name: 'Remove', exact: true }).click();

    await expect(theirs).toHaveCount(0);
    await expect(comments).toHaveCount(1);
    await expect(comments.first()).toContainText('where is this?');
  });

  test("a stranger's comment on a stranger's post offers Report, not Remove", async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    // Post 10 is @nightowl's and its comment is @lens_lena's: neither account is the player's.
    await openPost(frame, 10);

    const row = frame.locator('[data-testid="glimpse-comment"][data-comment-id="4"]');
    await expect(row).toContainText('great shot');
    await expect(row.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);

    await row.getByRole('button', { name: 'Report comment' }).click();
    await expect(frame.locator('text=Report content')).toBeVisible();
  });

  test("the author removes their own comment on somebody else's post", async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    // Post 11 is @lens_lena's; comment 3 is @ada's. Remove is offered because the comment is
    // the player's, which is the other half of the rule from the owner case above.
    await openPost(frame, 11);

    const mine = frame.locator('[data-testid="glimpse-comment"][data-comment-id="3"]');
    await expect(mine.getByRole('button', { name: 'Report comment' })).toHaveCount(0);
    await mine.getByRole('button', { name: 'Remove', exact: true }).click();

    await expect(mine).toHaveCount(0);
  });

  test('composes a post from a gallery photo and shows it at the top', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await frame.getByRole('button', { name: 'New post' }).click();

    // No photo, no post: Share starts disabled.
    const share = frame.getByRole('button', { name: 'Share', exact: true });
    await expect(share).toBeDisabled();

    await frame.getByRole('button', { name: 'Add photos' }).first().click();
    const picker = frame.getByRole('dialog', { name: 'Select Photos' });
    await expect(picker).toBeVisible();
    await picker.locator('.grid button').first().click();
    await picker.getByRole('button', { name: /^Done/ }).click();
    await expect(picker).toHaveCount(0);

    await expect(
      frame.getByTestId('glimpse-composer-photos').getByRole('button', {
        name: 'Remove photo'
      })
    ).toHaveCount(1);
    // A photo is all a post needs; the caption is optional.
    await expect(share).toBeEnabled();
    await frame.getByRole('textbox', { name: 'Caption' }).fill('shared from e2e');
    await share.click();

    const first = frame.getByTestId('glimpse-post').first();
    await expect(first).toContainText('shared from e2e');
    await expect(first).toHaveAccessibleName('Post by @ada');
    await expect(frame.getByTestId('glimpse-post')).toHaveCount(13);
  });

  test('a photo can be taken back out of the composer before sharing', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await frame.getByRole('button', { name: 'New post' }).click();
    await frame.getByRole('button', { name: 'Add photos' }).first().click();
    const picker = frame.getByRole('dialog', { name: 'Select Photos' });
    await picker.locator('.grid button').first().click();
    await picker.getByRole('button', { name: /^Done/ }).click();

    await frame.getByRole('button', { name: 'Remove photo' }).click();

    await expect(frame.getByRole('button', { name: 'Remove photo' })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
  });

  test("reports somebody else's post, which reaches the report dialog", async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await post(frame, 11).getByRole('button', { name: 'More actions' }).click();
    await frame.getByRole('menuitem', { name: 'Report post' }).click();

    await expect(frame.locator('text=Report content')).toBeVisible();
  });

  test('on your own post the menu edits or deletes, and never reports', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    const card = post(frame, 12);
    await card.getByRole('button', { name: 'More actions' }).click();

    await expect(frame.getByRole('menuitem', { name: 'Report post' })).toHaveCount(0);
    await expect(frame.getByRole('menuitem', { name: 'Delete post' })).toBeVisible();

    await frame.getByRole('menuitem', { name: 'Delete post' }).click();
    await frame.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(post(frame, 12)).toHaveCount(0);
    await expect(frame.getByTestId('glimpse-post')).toHaveCount(11);
  });

  test('a profile is a three-column grid, and Follow toggles', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await post(frame, 11).getByRole('button', { name: "Lena's profile" }).click();

    const grid = frame.getByTestId('glimpse-grid');
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('button', { name: 'Open post by @lens_lena' })).toHaveCount(5);
    // Geometry rather than a style read: three tiles share a row and the fourth wraps below.
    const tiles = grid.getByRole('button', { name: 'Open post by @lens_lena' });
    const [a, b, c, d] = await Promise.all([0, 1, 2, 3].map((n) => tiles.nth(n).boundingBox()));
    expect(Math.abs(a!.y - b!.y), 'tiles 1 and 2 share a row').toBeLessThan(1);
    expect(Math.abs(a!.y - c!.y), 'tiles 1 and 3 share a row').toBeLessThan(1);
    expect(d!.y, 'the fourth wraps to a second row').toBeGreaterThan(a!.y + a!.height - 1);

    const followers = frame.getByTestId('glimpse-followers');
    const before = Number((await followers.innerText()).match(/\d+/)?.[0]);

    await frame.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
    await expect(followers).toContainText(String(before + 1));

    await frame.getByRole('button', { name: 'Following', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    await expect(followers).toContainText(String(before));
  });

  test('your own profile offers Edit profile, not Follow', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await post(frame, 12).getByRole('button', { name: "Ada's profile" }).click();

    await expect(frame.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0);
    await expect(frame.getByTestId('glimpse-grid')).toBeVisible();
  });

  test('opening a post from a profile grid returns to that grid on Back', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await post(frame, 11).getByRole('button', { name: "Lena's profile" }).click();
    await frame.getByRole('button', { name: 'Open post by @lens_lena' }).first().click();
    await expect(frame.getByTestId('glimpse-comments')).toBeVisible();

    await page.keyboard.press('Backspace');

    await expect(frame.getByTestId('glimpse-grid')).toBeVisible();
  });

  /** Direct messages (MICA-393). Seed: @lens_lena has a thread with the player, @nightowl none. */
  const openMessagesTab = async (frame: FrameLocator) => {
    await frame.getByRole('button', { name: 'Messages', exact: true }).click();
    await expect(frame.getByTestId('glimpse-messages')).toBeVisible();
  };
  const lenaRow = (frame: FrameLocator) =>
    frame.getByTestId('dm-inbox-row').filter({ hasText: 'lens_lena' });
  const messageButton = (frame: FrameLocator) => frame.getByTestId('glimpse-message');
  /** Open a profile from the feed through a post's author button, then wait for its grid. */
  const openAuthorProfile = async (frame: FrameLocator, postId: number) => {
    await post(frame, postId)
      .getByRole('button', { name: /'s profile$/ })
      .click();
    await expect(frame.getByTestId('glimpse-grid')).toBeVisible();
  };
  /** Admin's pending queue: one "Remove for everyone" per outstanding report. */
  const pendingReports = async (page: Page) => {
    await page.locator("button[aria-label='Return to home screen']").click();
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
    return page.getByRole('button', { name: 'Remove for everyone' });
  };

  test('the Messages tab lists lens_lena with one unread and nobody else', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openMessagesTab(frame);

    await expect(frame.getByTestId('dm-inbox-row')).toHaveCount(1);
    await expect(lenaRow(frame)).toHaveAttribute('data-peer-account-id', '21');
    await expect(lenaRow(frame).getByTestId('dm-inbox-unread')).toHaveText('1');
    await expect(frame.getByTestId('dm-inbox-row').filter({ hasText: 'nightowl' })).toHaveCount(0);
  });

  test('opening a thread shows both sides, and the unread badge is gone on return', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openMessagesTab(frame);
    await lenaRow(frame).click();

    await expect(frame.getByTestId('glimpse-dm-header')).toContainText('@lens_lena');
    await expect(frame.getByTestId('dm-message')).toHaveCount(2);
    const mine = frame.locator('[data-testid="dm-message"][data-message-id="2"]');
    const theirs = frame.locator('[data-testid="dm-message"][data-message-id="3"]');
    await expect(mine).toContainText('your pier shot is lovely');
    await expect(mine).toHaveAttribute('data-mine', 'true');
    await expect(theirs).toContainText('golden hour does the work');
    await expect(theirs).toHaveAttribute('data-mine', 'false');

    await page.keyboard.press('Backspace');

    await expect(frame.getByTestId('dm-inbox')).toBeVisible();
    await expect(lenaRow(frame)).toBeVisible();
    await expect(lenaRow(frame).getByTestId('dm-inbox-unread')).toHaveCount(0);
  });

  test('a reply appears exactly once', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openMessagesTab(frame);
    await lenaRow(frame).click();
    await expect(frame.getByTestId('dm-message')).toHaveCount(2);

    const text = 'see you at the pier';
    await frame.getByPlaceholder('Message @lens_lena…').fill(text);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();

    // The send's answer and the app-event push both carry this line; the store merges by id.
    await expect(frame.getByTestId('dm-message')).toHaveCount(3);
    const sent = frame.getByTestId('dm-message').filter({ hasText: text });
    await expect(sent).toHaveCount(1);
    await expect(sent).toHaveAttribute('data-mine', 'true');
    await expect(frame.getByPlaceholder('Message @lens_lena…')).toHaveValue('');
  });

  test("Message on a stranger's profile opens an empty thread, and a send creates it", async ({
    page
  }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openAuthorProfile(frame, 10);
    await messageButton(frame).click();

    await expect(frame.getByTestId('glimpse-dm-header')).toContainText('@nightowl');
    await expect(frame.getByTestId('dm-thread')).toBeVisible();
    await expect(frame.getByTestId('dm-message')).toHaveCount(0);

    const text = 'hello from the e2e';
    await frame.getByPlaceholder('Message @nightowl…').fill(text);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(frame.getByTestId('dm-message')).toHaveCount(1);
    await expect(frame.getByTestId('dm-message')).toContainText(text);

    // Back to the profile it was opened from, then out to the feed and across to the inbox.
    await page.keyboard.press('Backspace');
    await expect(frame.getByTestId('glimpse-grid')).toBeVisible();
    await page.keyboard.press('Backspace');
    await openMessagesTab(frame);
    await expect(frame.getByTestId('dm-inbox-row')).toHaveCount(2);
    await expect(frame.getByTestId('dm-inbox-row').filter({ hasText: 'nightowl' })).toHaveAttribute(
      'data-peer-account-id',
      '22'
    );
  });

  test('your own profile offers no Message button', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await post(frame, 12).getByRole('button', { name: "Ada's profile" }).click();

    await expect(frame.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    await expect(messageButton(frame)).toHaveCount(0);
  });

  test("another account's profile does offer Message", async ({ page }) => {
    // The counterpart of the test above: without it, a button that never rendered passes both.
    const frame = addOnFrame(page, 'glimpse');
    await openAuthorProfile(frame, 11);

    await expect(messageButton(frame)).toBeVisible();
  });

  test('a message in the thread can be reported, and Admin queues it', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    await openMessagesTab(frame);
    await lenaRow(frame).click();

    await frame
      .locator('[data-testid="dm-message"][data-message-id="3"]')
      .getByRole('button', { name: 'Report message' })
      .click();
    await expect(frame.locator('text=Report content')).toBeVisible();
    await frame.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByText('Report sent for review')).toBeVisible();

    // The seeded report plus this one.
    await expect(await pendingReports(page)).toHaveCount(2);
  });

  test('neither the inbox nor the thread shows a citizenid', async ({ page }) => {
    const frame = addOnFrame(page, 'glimpse');
    const leak = /citizen/i;
    await openMessagesTab(frame);
    await expect(lenaRow(frame)).toBeVisible();
    await expect(frame.getByTestId('dm-inbox')).not.toContainText(leak);

    await lenaRow(frame).click();
    await expect(frame.getByTestId('dm-message')).toHaveCount(2);
    await expect(frame.getByTestId('dm-thread')).not.toContainText(leak);
    await expect(frame.getByTestId('glimpse-dm-header')).not.toContainText(leak);
  });
});

/**
 * A notification's deep link, `glimpse?postId=<id>`, is how a comment or a mention lands on the
 * post it was about. Delivered the way the server delivers it — an `appEvent` envelope — and
 * followed by tapping its toast, so the whole path from envelope to rendered post is exercised.
 * The app is installed but deliberately not opened first: a resident app would already be
 * showing the feed, and the assertion would pass whatever the link did.
 */
test('a notification deep link opens the post it names', async ({ page }) => {
  await seedHomeGrid(page, ['store']);
  await page.goto('/');
  await installAddOn(page, 'Glimpse');
  await dismissToasts(page);

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            app: 'glimpse',
            event: 'comment',
            payload: { post_id: 7 },
            at: Date.now(),
            deepLink: 'glimpse?postId=7',
            notify: { type: 'info', title: 'New comment on e2e', message: 'Tap to read' }
          }
        }
      })
    );
  });
  await page.getByText('New comment on e2e').click();

  const frame = addOnFrame(page, 'glimpse');
  const comments = frame.getByTestId('glimpse-comments');
  await expect(comments).toBeVisible();
  // Post 7 is @nightowl's, with a null caption: the one screen that can only be that post.
  await expect(frame.getByRole('article', { name: 'Post by @nightowl' })).toHaveAttribute(
    'data-post-id',
    '7'
  );
  await expect(frame.getByTestId('glimpse-post')).toHaveCount(1);
});

/** `glimpse:view` answers null for an id it does not have: a named dead end, and Back leaves it. */
test('a deep link to a post that does not exist shows Post unavailable, and Back closes it', async ({
  page
}) => {
  // Not opened first, as above: a resident app would show the feed whatever the link did.
  await seedHomeGrid(page, ['store']);
  await page.goto('/');
  await installAddOn(page, 'Glimpse');
  await dismissToasts(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            app: 'glimpse',
            event: 'comment',
            payload: { post_id: 9999 },
            at: Date.now(),
            deepLink: 'glimpse?postId=9999',
            notify: { type: 'info', title: 'Gone post', message: 'Tap to read' }
          }
        }
      })
    );
  });
  await page.getByText('Gone post').click();

  const frame = addOnFrame(page, 'glimpse');
  await expect(frame.locator('text=Post unavailable')).toBeVisible();
  await expect(frame.getByTestId('glimpse-post')).toHaveCount(0);

  await page.keyboard.press('Backspace');

  await expect(frame.locator('text=Post unavailable')).toHaveCount(0);
  await expect(frame.getByTestId('glimpse-post')).toHaveCount(12);
});

/** `glimpse?dmHandle=<handle>` resolves the handle and lands in that thread, over the inbox. */
test('a deep link to a DM opens the thread with that account', async ({ page }) => {
  // Not opened first, as above: a resident app would show the feed whatever the link did.
  await seedHomeGrid(page, ['store']);
  await page.goto('/');
  await installAddOn(page, 'Glimpse');
  await dismissToasts(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          action: 'appEvent',
          data: {
            app: 'glimpse',
            event: 'dm',
            payload: {},
            at: Date.now(),
            deepLink: 'glimpse?dmHandle=lens_lena',
            notify: { type: 'info', title: 'New DM e2e', message: 'Tap to read' }
          }
        }
      })
    );
  });
  await page.getByText('New DM e2e').click();

  const frame = addOnFrame(page, 'glimpse');
  await expect(frame.getByTestId('glimpse-dm-header')).toContainText('@lens_lena');
  await expect(frame.getByTestId('dm-message')).toHaveCount(2);

  await page.keyboard.press('Backspace');
  await expect(frame.getByTestId('dm-inbox')).toBeVisible();
});
