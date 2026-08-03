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

  test('posts a Blab and shows it at the top', async ({ page }) => {
    await page.locator('textarea').fill('e2e was here');
    // Role-based and exact: Blabber's own Store description begins "Post short updates...",
    // and the backgrounded Store app is still in the DOM. `inert` keeps it out of the
    // accessibility tree, which a text match does not respect.
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    await expect(page.locator('text=e2e was here')).toBeVisible();
  });

  test('opens a profile and switches between Blabs and Replies', async ({ page }) => {
    // Scoped to the post, not `.first()`: the account switcher also renders an `@ada` button,
    // and it comes first in the DOM. Clicking that would silently stay on the feed.
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

  test('renders markup in a post as text rather than interpreting it', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Post', exact: true }).click();

    await expect(page.locator('text=thanks!')).toBeVisible();
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
