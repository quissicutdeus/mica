import { test, expect } from '../support/test';
import { addOnFrame, dismissToasts } from '../support/addon';
import { bootWithStore, homeButton, installFromStore, switchTo } from '../support/deviceStore';

/**
 * A phone and a tablet hold separate notes (MICA-264): the same citizen, two identities, so a
 * note written on one is not on the other. Notes is installed on both devices first, since
 * each keeps its own installs — without that the absence below could just be "not installed".
 *
 * The two layouts differ (`tablet/notes.spec.ts` has the tablet's), so the note is written
 * through whichever the device on screen shows: the phone's "Add" sheet has a content
 * placeholder of "Content" where the tablet's editor says "Markdown content...".
 */
const openNotes = async (page: import('@playwright/test').Page) => {
  await homeButton(page, /Notes/).click();
  await dismissToasts(page);
  await expect(addOnFrame(page, 'notes').locator('h1', { hasText: 'Notes' })).toBeVisible();
};

const writeNote = async (
  page: import('@playwright/test').Page,
  device: 'phone' | 'tablet',
  title: string
) => {
  const frame = addOnFrame(page, 'notes');
  await frame
    .getByRole('button', { name: /^New Note$|^Add/ })
    .first()
    .click();
  await frame.getByPlaceholder('Title').fill(title);
  const content = device === 'tablet' ? 'Markdown content...' : 'Content';
  await frame.getByPlaceholder(content).first().fill(`Body of ${title}`);
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(frame.getByRole('button', { name: new RegExp(title) })).toBeVisible();
};

test('a note made on the tablet is not on the phone, and the reverse', async ({ page }) => {
  await bootWithStore(page, 'phone', { phone: ['notes'], tablet: ['notes'] });
  await installFromStore(page, 'Notes');
  await switchTo(page, 'tablet');
  await installFromStore(page, 'Notes');

  await openNotes(page);
  await writeNote(page, 'tablet', 'Tablet only');

  await switchTo(page, 'phone');
  await openNotes(page);
  const phoneFrame = addOnFrame(page, 'notes');
  await expect(phoneFrame.getByRole('button', { name: /Tablet only/ })).toHaveCount(0);
  await writeNote(page, 'phone', 'Phone only');

  await switchTo(page, 'tablet');
  const tabletFrame = addOnFrame(page, 'notes');
  await expect(tabletFrame.getByRole('button', { name: /Phone only/ })).toHaveCount(0);
  // The tablet's own note is still there: the phone's write did not replace its list.
  await expect(tabletFrame.getByRole('button', { name: /Tablet only/ })).toBeVisible();
});
