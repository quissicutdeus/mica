import { test, expect, type Page } from '../support/test';
import { addOnFrame, dismissToasts } from '../support/addon';
import {
  bootWithStore,
  goHome,
  homeButton,
  installFromStore,
  switchTo
} from '../support/deviceStore';

/**
 * An add-on with a tablet root (MICA-265), proved on Notes.
 *
 * Notes is `core: false`, so the shell never mounts its `tablet.svelte` itself: the add-on
 * build hands the file to `bootAddOn` as a second root, and the sandboxed frame mounts it
 * instead of `index.svelte` while the tablet is on screen. Until MICA-265 `index.svelte`
 * branched to it from the inside, so the two-pane layout alone (which `tablet/notes.spec.ts`
 * covers) does not say which of the two did the mounting. What does:
 *
 * - a search hit's deep link lands in the **tablet root's** detail pane. The phone root no
 *   longer forwards it, so only a tablet root with its own `useDeepLink` can select the
 *   note there;
 * - the same bundle draws the phone root on the phone and the tablet root on the tablet,
 *   chosen inside the frame by the device the shell reports.
 *
 * A device switch rebuilds the frame today (checked while writing this: a mark left in the
 * frame's document did not survive one), so a root swapping *inside* a running frame is
 * not reachable from here. `sdk/host/iframe/bootTablet.test.ts` holds that half.
 */

const notes = (page: Page) => addOnFrame(page, 'notes');
/** Only the tablet root draws this: it is the right pane with nothing selected. */
const tabletRoot = (page: Page) => notes(page).getByText('No note selected');

const openNotes = async (page: Page) => {
  await homeButton(page, /Notes/).click();
  await dismissToasts(page);
  await expect(notes(page).locator('h1', { hasText: 'Notes' })).toBeVisible();
};

const writeNote = async (page: Page, title: string, body: string) => {
  await notes(page).getByRole('button', { name: 'New Note', exact: true }).click();
  await notes(page).getByPlaceholder('Title').fill(title);
  await notes(page).getByPlaceholder('Markdown content...').fill(body);
  await notes(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notes(page).getByRole('button', { name: new RegExp(title) })).toBeVisible();
};

test.describe('An add-on ships a tablet root (MICA-265)', () => {
  test('a search hit opens the note in the tablet root, not the phone root', async ({ page }) => {
    await bootWithStore(page, 'tablet', { tablet: ['notes'] });
    await installFromStore(page, 'Notes');
    await openNotes(page);
    await expect(tabletRoot(page)).toBeVisible();

    // A title no fixture has, so the one hit below is this note and nothing seeded.
    await writeNote(page, 'Lighthouse rota', 'Keeper changes at dawn.');
    // Saving a new note selects nothing: the pane is empty until the link fills it.
    await expect(tabletRoot(page)).toBeVisible();

    await goHome(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'App Drawer' });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel('Search your phone').fill('lighthouse');
    await expect(drawer.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: /Lighthouse rota/ }).click();

    // `notes-detail` is the tablet root's right pane; the phone root has no such element.
    const detail = notes(page).getByTestId('notes-detail');
    await expect(detail.locator('h2', { hasText: 'Lighthouse rota' })).toBeVisible();
    await expect(detail.getByText('Keeper changes at dawn.')).toBeVisible();
  });

  test('one bundle draws the phone root on the phone and the tablet root on the tablet', async ({
    page
  }) => {
    await bootWithStore(page, 'tablet', { phone: ['notes'], tablet: ['notes'] });
    await installFromStore(page, 'Notes');
    await openNotes(page);
    await expect(tabletRoot(page)).toBeVisible();

    await switchTo(page, 'phone');
    await installFromStore(page, 'Notes');
    await openNotes(page);
    // The phone root: its own list, with no right pane beside it.
    await expect(notes(page).getByRole('button', { name: 'New Note' })).toBeVisible();
    await expect(tabletRoot(page)).toHaveCount(0);
    await expect(notes(page).getByTestId('notes-detail')).toHaveCount(0);

    await switchTo(page, 'tablet');
    await expect(tabletRoot(page)).toBeVisible();
  });
});
