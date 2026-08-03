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
    // Ada has no replies in the mock, and the empty state says so rather than showing her posts.
    await expect(page.locator('text=No replies yet')).toBeVisible();

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
});
