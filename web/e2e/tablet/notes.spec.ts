import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, pressDeviceKey, settledFrameBox } from '../support/device';
import { addOnFrame, dismissToasts, installAddOn } from '../support/addon';

/**
 * Notes on the tablet is two panes (MICA-261): the list on the left, the selected note on
 * the right, both on screen at once — the phone's `apps/notes.spec.ts` only covers that the
 * screen renders, so create/edit/delete on the wide root is otherwise unexercised.
 *
 * Notes is `core: false`, so it has to be installed from the Store — which is a phone-only
 * app — before it can be raised on the tablet at all (`tablet/launcher.spec.ts` already
 * covers that install-on-one-device/appears-on-the-other path; this starts from it).
 *
 * `tablet.svelte`'s new-note sheet passes `variant="edit"` to `NoteEditor` — unlike the
 * phone, which uses `add` for a fresh note and `edit` only once one exists — so the
 * content field's placeholder is `notes.markdownPlaceholder` ("Markdown content...") in
 * both states here, never `notes.contentPlaceholder`.
 */
test.describe('Notes on the tablet', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['store']);
    await seedHomeGrid(page, ['notes'], 'tablet');
    await gotoDevice(page, 'phone');
    await installAddOn(page, 'Notes');

    await pressDeviceKey(page, 'tablet');
    await settledFrameBox(page, 'tablet');
    await page.getByRole('button', { name: /Notes/i }).first().click();
    await dismissToasts(page);

    const frame = addOnFrame(page, 'notes');
    await expect(frame.locator('h1', { hasText: 'Notes' })).toBeVisible();
  });

  test('creates a note, selects it, and reads it back in the detail pane', async ({ page }) => {
    const frame = addOnFrame(page, 'notes');
    await expect(frame.getByText('No note selected')).toBeVisible();

    await frame.getByRole('button', { name: 'New Note', exact: true }).click();
    await frame.getByPlaceholder('Title').fill('Tablet patrol notes');
    await frame.getByPlaceholder('Markdown content...').fill('Checked the east gate.');
    await frame.getByRole('button', { name: 'Save', exact: true }).click();

    // Saving a new note leaves nothing selected — it lands in the list, not the pane.
    await expect(frame.getByText('No note selected')).toBeVisible();
    const row = frame.getByRole('button', { name: /Tablet patrol notes/ });
    await expect(row).toBeVisible();

    await row.click();
    // Scoped to the detail pane: the list row's own truncated preview repeats the same
    // text, and an unscoped match against the whole frame hits both.
    const detail = frame.getByTestId('notes-detail');
    await expect(detail.locator('h2', { hasText: 'Tablet patrol notes' })).toBeVisible();
    await expect(detail.getByText('Checked the east gate.')).toBeVisible();
  });

  test('edits the selected note in place', async ({ page }) => {
    const frame = addOnFrame(page, 'notes');
    await frame.getByRole('button', { name: 'New Note', exact: true }).click();
    await frame.getByPlaceholder('Title').fill('Draft');
    await frame.getByPlaceholder('Markdown content...').fill('First version.');
    await frame.getByRole('button', { name: 'Save', exact: true }).click();
    await frame.getByRole('button', { name: /Draft/ }).click();

    await frame.getByRole('button', { name: 'Edit note' }).click();
    const content = frame.getByPlaceholder('Markdown content...');
    await content.fill('Second version.');
    await frame.getByRole('button', { name: 'Save', exact: true }).click();

    // Scoped to the detail pane — see the note above on why an unscoped match is ambiguous.
    const detail = frame.getByTestId('notes-detail');
    await expect(detail.getByText('Second version.')).toBeVisible();
    await expect(detail.getByText('First version.')).toHaveCount(0);
  });

  test('deletes the selected note from the editor, clearing both panes', async ({ page }) => {
    const frame = addOnFrame(page, 'notes');
    await frame.getByRole('button', { name: 'New Note', exact: true }).click();
    await frame.getByPlaceholder('Title').fill('Temporary');
    await frame.getByPlaceholder('Markdown content...').fill('Delete me.');
    await frame.getByRole('button', { name: 'Save', exact: true }).click();
    await frame.getByRole('button', { name: /Temporary/ }).click();

    await frame.getByRole('button', { name: 'Edit note' }).click();
    await frame.getByRole('button', { name: 'Delete', exact: true }).click();

    const confirm = frame.getByRole('dialog', { name: 'Delete Note?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(frame.getByRole('button', { name: /Temporary/ })).toHaveCount(0);
    await expect(frame.getByText('No note selected')).toBeVisible();
  });
});
